// 期間指定の差分同期。DB に無い開催だけを JRA 公式サイトから取得する。
import { db, tx } from './db.js';
import { fetchMonth, fetchMeeting, fetchMeetingResults, hooks } from './jra.js';

export const status = {
  running: false,
  phase: 'idle',      // idle | calendar | races | done | error
  from: null,
  to: null,
  daysTotal: 0,       // 取得対象の開催数（場・日ごと）
  daysDone: 0,
  racesFetched: 0,
  currentDate: null,
  message: '',
  error: null,
  startedAt: null,
  finishedAt: null,
  waiting: null,      // アクセス制限で待機中ならそのメッセージ
};
hooks.onWait = (msg) => { status.waiting = msg; };

// 日本時間の今日 'YYYY-MM-DD'
export function todayJST() {
  return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
}

const pad = (n) => String(n).padStart(2, '0');
const ymOf = (date) => date.slice(0, 7);
function addMonth(ym, n) {
  let [y, m] = ym.split('-').map(Number);
  m += n;
  while (m > 12) { m -= 12; y++; }
  while (m < 1) { m += 12; y--; }
  return `${y}-${pad(m)}`;
}
function monthsBetween(from, to) {
  const out = [];
  for (let ym = ymOf(from); ym <= ymOf(to); ym = addMonth(ym, 1)) out.push(ym);
  return out;
}
const monthEnd = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const now = () => new Date().toISOString();
const daysAgo = (date, n) => new Date(Date.parse(date) - n * 864e5).toISOString().slice(0, 10);

const q = {
  month: db.prepare('SELECT ym, cname, fetched_at FROM months WHERE ym = ?'),
  addMonthLink: db.prepare('INSERT INTO months (ym, cname) VALUES (?, ?) ON CONFLICT(ym) DO UPDATE SET cname = excluded.cname'),
  markMonth: db.prepare('INSERT INTO months (ym, fetched_at) VALUES (?, ?) ON CONFLICT(ym) DO UPDATE SET fetched_at = excluded.fetched_at'),
  addMeeting: db.prepare(`INSERT INTO meetings (key, date, venue_code, venue, srl_cname) VALUES (:key, :date, :venue_code, :venue, :cname)
    ON CONFLICT(key) DO UPDATE SET srl_cname = excluded.srl_cname`),
  pending: db.prepare('SELECT * FROM meetings WHERE complete = 0 AND date BETWEEN ? AND ? ORDER BY date, venue_code'),
  setSes: db.prepare('UPDATE meetings SET ses_cname = ?, races_expected = ? WHERE key = ?'),
  markMeeting: db.prepare('UPDATE meetings SET complete = ?, fetched_at = ? WHERE key = ?'),
  insRace: db.prepare(`INSERT OR REPLACE INTO races
    (race_id, date, venue_code, venue, race_no, name, surface, distance, weather, track_condition, class_text, headcount, fetched_at)
    VALUES (:race_id, :date, :venue_code, :venue, :race_no, :name, :surface, :distance, :weather, :track_condition, :class_text, :headcount, :fetched_at)`),
  delEntries: db.prepare('DELETE FROM entries WHERE race_id = ?'),
  delPayouts: db.prepare('DELETE FROM payouts WHERE race_id = ?'),
  insEntry: db.prepare(`INSERT OR REPLACE INTO entries
    (race_id, horse_no, frame_no, finish, finish_num, horse_id, horse_name, sex_age, weight_carried,
     jockey_id, jockey_name, trainer_id, trainer_name, odds, popularity, horse_weight)
    VALUES (:race_id, :horse_no, :frame_no, :finish, :finish_num, :horse_id, :horse_name, :sex_age, :weight_carried,
     :jockey_id, :jockey_name, :trainer_id, :trainer_name, :odds, :popularity, :horse_weight)`),
  insPayout: db.prepare(`INSERT OR REPLACE INTO payouts (race_id, bet_type, combination, amount, popularity)
    VALUES (:race_id, :bet_type, :combination, :amount, :popularity)`),
};

function saveRace({ race, entries, payouts }) {
  tx(() => {
    q.delEntries.run(race.race_id);
    q.delPayouts.run(race.race_id);
    q.insRace.run({ ...race, fetched_at: now() });
    for (const e of entries) q.insEntry.run({ ...e, race_id: race.race_id });
    for (const p of payouts) q.insPayout.run({ ...p, race_id: race.race_id });
  });
}

/** 月ページを取得して開催と他の月へのリンクを保存 */
async function loadMonth(ym, cname) {
  status.message = `${ym.replace('-', '年')}月の開催一覧を取得中`;
  const { meetings, months } = await fetchMonth(cname);
  tx(() => {
    for (const [m, c] of Object.entries(months)) q.addMonthLink.run(m, c);
    for (const { key, date, venue_code, venue, cname } of meetings) {
      if (ymOf(date) === ym) q.addMeeting.run({ key, date, venue_code, venue, cname });
    }
    q.markMonth.run(ym, now());
  });
}

/** 月ページの cname を得る。未知なら翌月のページから「前月」リンクを辿る。 */
async function monthCname(ym, currentYm) {
  if (ym === currentYm) return undefined; // 当月は既定の入口ページ
  const known = q.month.get(ym)?.cname;
  if (known) return known;
  const next = addMonth(ym, 1);
  if (next > currentYm) throw new Error(`${ym} の開催一覧ページが見つかりません`);
  await loadMonth(next, await monthCname(next, currentYm));
  const c = q.month.get(ym)?.cname;
  if (!c) throw new Error(`${ym} の開催一覧ページへのリンクが見つかりません`);
  return c;
}

async function syncCalendar(from, to, today) {
  const currentYm = ymOf(today);
  // 新しい月から順に（前月リンクを辿るため）
  for (const ym of monthsBetween(from, to).reverse()) {
    const fetched = q.month.get(ym)?.fetched_at;
    // 取得時点で月末を過ぎていた月は確定済みとみなして再取得しない
    if (fetched && fetched.slice(0, 10) > monthEnd(ym)) continue;
    await loadMonth(ym, await monthCname(ym, currentYm));
  }
}

async function syncMeeting(m, today) {
  status.message = `${m.date} ${m.venue} の結果を取得中`;
  let ses = m.ses_cname, expected = m.races_expected;
  if (!ses) {
    ({ sesCname: ses, raceCount: expected } = await fetchMeeting(m.srl_cname));
    if (!ses) throw new Error(`${m.date} ${m.venue} の結果一覧ページが見つかりません`);
    q.setSes.run(ses, expected, m.key);
  }
  const results = await fetchMeetingResults(ses, m);
  for (const r of results) saveRace(r);
  status.racesFetched += results.length;
  // 全レース確定済み、または 1 週間以上前（開催中止などで結果が無いレース）なら完了扱い
  const complete = (expected > 0 && results.length >= expected) || m.date < daysAgo(today, 7);
  q.markMeeting.run(complete ? 1 : 0, now(), m.key);
}

/** from〜to（YYYY-MM-DD）の不足データを取得する。実行中なら現在のジョブを返す。 */
export function startSync(from, to) {
  if (status.running) return status;
  const today = todayJST();
  if (to > today) to = today;
  Object.assign(status, {
    running: true, phase: 'calendar', from, to, daysTotal: 0, daysDone: 0, racesFetched: 0,
    currentDate: null, message: '開始', error: null, startedAt: now(), finishedAt: null, waiting: null,
  });
  (async () => {
    try {
      if (from <= to) {
        await syncCalendar(from, to, today);
        const meetings = q.pending.all(from, to);
        status.phase = 'races';
        status.daysTotal = meetings.length;
        for (const m of meetings) {
          status.currentDate = m.date;
          await syncMeeting(m, today);
          status.daysDone++;
        }
      }
      status.phase = 'done';
      status.message = status.racesFetched ? `${status.racesFetched} レースを新規取得しました` : 'データは最新です';
    } catch (e) {
      status.phase = 'error';
      status.error = String(e?.message || e);
      status.message = '取得中にエラーが発生しました';
      console.error(e);
    } finally {
      status.running = false;
      status.waiting = null;
      status.finishedAt = now();
    }
  })();
  return status;
}

export function dbStats() {
  return db.prepare(`SELECT COUNT(*) AS races, MIN(date) AS first_date, MAX(date) AS last_date,
    (SELECT COUNT(*) FROM entries) AS entries FROM races`).get();
}
