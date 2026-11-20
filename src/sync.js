// 期間指定の差分同期。DB に無い開催だけを JRA 公式サイトから取得する。
import { db, tx } from './db.js';
import { fetchMonth, fetchMeeting, fetchMeetingResults, fetchPeopleList, fetchKana, fetchCardMeetings, fetchCards, hooks } from './jra.js';
import { normalizeName } from '../public/sim.js';

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
    (race_id, date, venue_code, venue, race_no, name, surface, distance, weather, track_condition, class_text, grade, headcount, fetched_at)
    VALUES (:race_id, :date, :venue_code, :venue, :race_no, :name, :surface, :distance, :weather, :track_condition, :class_text, :grade, :headcount, :fetched_at)`),
  delEntries: db.prepare('DELETE FROM entries WHERE race_id = ?'),
  delPayouts: db.prepare('DELETE FROM payouts WHERE race_id = ?'),
  insEntry: db.prepare(`INSERT OR REPLACE INTO entries
    (race_id, horse_no, frame_no, finish, finish_num, horse_id, horse_name, sex_age, weight_carried,
     jockey_id, jockey_name, trainer_id, trainer_name, odds, popularity, horse_weight)
    VALUES (:race_id, :horse_no, :frame_no, :finish, :finish_num, :horse_id, :horse_name, :sex_age, :weight_carried,
     :jockey_id, :jockey_name, :trainer_id, :trainer_name, :odds, :popularity, :horse_weight)`),
  insPayout: db.prepare(`INSERT OR REPLACE INTO payouts (race_id, bet_type, combination, amount, popularity)
    VALUES (:race_id, :bet_type, :combination, :amount, :popularity)`),
  upsertPerson: db.prepare(`INSERT INTO people (kind, id, name, cname) VALUES (:kind, :id, :name, :cname)
    ON CONFLICT(kind, id) DO UPDATE SET name = excluded.name, cname = excluded.cname`),
  setKana: db.prepare('UPDATE people SET kana = ?, fetched_at = ? WHERE kind = ? AND id = ?'),
  // 出走データに登場する人のうち、読み仮名が未取得の人
  peopleTodo: db.prepare(`SELECT p.kind, p.id, p.name, p.cname FROM people p
    WHERE p.kana IS NULL AND p.cname IS NOT NULL AND (
      (p.kind = 'jockey' AND EXISTS (SELECT 1 FROM entries e WHERE e.jockey_id = p.id)) OR
      (p.kind = 'trainer' AND EXISTS (SELECT 1 FROM entries e WHERE e.trainer_id = p.id)))
    ORDER BY p.kind, p.id`),
  getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
  setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
};

function saveRace({ race, entries, payouts, people = [] }) {
  tx(() => {
    q.delEntries.run(race.race_id);
    q.delPayouts.run(race.race_id);
    q.insRace.run({ ...race, fetched_at: now() });
    for (const e of entries) q.insEntry.run({ ...e, race_id: race.race_id });
    for (const p of payouts) q.insPayout.run({ ...p, race_id: race.race_id });
    for (const p of people) q.upsertPerson.run(p);
  });
}

/**
 * 騎手・調教師の読み仮名（ひらがな検索用）を取得。
 * 名鑑の一覧は週 1 回だけ取り直し、プロフィールは未取得の人だけ取得する。
 */
async function syncPeople() {
  const listedAt = q.getMeta.get('people_list_at')?.value;
  if (!listedAt || Date.now() - Date.parse(listedAt) > 7 * 864e5) {
    for (const kind of ['jockey', 'trainer']) {
      status.message = `${kind === 'jockey' ? '騎手' : '調教師'}名鑑の一覧を取得中`;
      const list = await fetchPeopleList(kind);
      tx(() => { for (const p of list) q.upsertPerson.run({ kind, ...p }); });
    }
    q.setMeta.run('people_list_at', now());
  }
  const todo = q.peopleTodo.all();
  let done = 0;
  for (const p of todo) {
    // 「C.ルメール」のようにカタカナだけの名前は読みが不要
    if (/^[゠-ヿA-Za-z]*$/.test(normalizeName(p.name))) { q.setKana.run('', now(), p.kind, p.id); continue; }
    status.message = `騎手・調教師の読み仮名を取得中（${++done}/${todo.length}）`;
    q.setKana.run(normalizeName(await fetchKana(p.kind, p.cname)), now(), p.kind, p.id);
  }
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

// ---- 出馬表 ----
const CARD_REFRESH_MS = 30 * 60e3; // 出馬表（オッズ・取消）は 30 分ごとまで取り直す
const qc = {
  delOld: db.prepare('DELETE FROM cards WHERE date < ?'),
  delRace: db.prepare('DELETE FROM cards WHERE race_id = ?'),
  delEntries: db.prepare('DELETE FROM card_entries WHERE race_id = ?'),
  insCard: db.prepare(`INSERT INTO cards (race_id, date, venue_code, venue, race_no, name, surface, distance, class_text, grade, post_time, headcount, fetched_at)
    VALUES (:race_id, :date, :venue_code, :venue, :race_no, :name, :surface, :distance, :class_text, :grade, :post_time, :headcount, :fetched_at)`),
  insEntry: db.prepare(`INSERT INTO card_entries (race_id, seq, horse_no, frame_no, horse_id, horse_name, sex_age, weight_carried, jockey_id, jockey_name, trainer_id, trainer_name, odds, status)
    VALUES (:race_id, :seq, :horse_no, :frame_no, :horse_id, :horse_name, :sex_age, :weight_carried, :jockey_id, :jockey_name, :trainer_id, :trainer_name, :odds, :status)`),
};

/** 出馬表を取得（force でなければ 30 分以内の再取得はしない）。結果が出たレースの分は消す。 */
export async function syncCards({ force = false } = {}) {
  const today = todayJST();
  qc.delOld.run(today);
  const last = q.getMeta.get('cards_at')?.value;
  if (!force && last && Date.now() - Date.parse(last) < CARD_REFRESH_MS) return;
  status.message = '出馬表を取得中';
  const meetings = (await fetchCardMeetings()).filter((m) => m.date >= today);
  for (const m of meetings) {
    status.message = `${m.date} ${m.venue} の出馬表を取得中`;
    const cards = await fetchCards(m);
    tx(() => {
      for (const { race, entries } of cards) {
        qc.delEntries.run(race.race_id);
        qc.delRace.run(race.race_id);
        qc.insCard.run({ ...race, fetched_at: now() });
        entries.forEach((e, i) => qc.insEntry.run({ ...e, seq: i + 1, race_id: race.race_id }));
      }
    });
  }
  // 結果が取り込まれたレースは出馬表から外す
  db.exec('DELETE FROM cards WHERE race_id IN (SELECT race_id FROM races)');
  q.setMeta.run('cards_at', now());
}

/**
 * 保存する項目を増やしたときの取り直し。DATA_VERSION を上げると、取得済みの開催を
 * 未完了に戻して次回の同期で結果ページを 1 回ずつ取り直す（進み具合は meetings.complete が持つ）。
 *   2: レースの格付け（G1〜G3・リステッド）を追加
 */
const DATA_VERSION = 2;
function migrate() {
  const v = Number(q.getMeta.get('data_version')?.value || 1);
  if (v >= DATA_VERSION) return;
  tx(() => {
    db.exec('UPDATE meetings SET complete = 0');
    q.setMeta.run('data_version', String(DATA_VERSION));
  });
}

/** from〜to（YYYY-MM-DD）の不足データを取得する。実行中なら現在のジョブを返す。 */
export function startSync(from, to, opts = {}) {
  if (status.running) return status;
  const today = todayJST();
  if (to > today) to = today;
  Object.assign(status, {
    running: true, phase: 'calendar', from, to, daysTotal: 0, daysDone: 0, racesFetched: 0,
    currentDate: null, message: '開始', error: null, cardsError: null, startedAt: now(), finishedAt: null, waiting: null,
  });
  (async () => {
    try {
      migrate();
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
        // 読み仮名・出馬表は補助なので、失敗してもレース結果の取得は成功扱いにする
        status.phase = 'people';
        try { await syncPeople(); } catch (e) { console.error('読み仮名の取得に失敗:', e); }
      }
      status.phase = 'cards';
      try { await syncCards({ force: opts.forceCards }); } catch (e) { console.error('出馬表の取得に失敗:', e); status.cardsError = String(e?.message || e); }
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
