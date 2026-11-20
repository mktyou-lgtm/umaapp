// JRA 公式サイト（www.jra.go.jp/JRADB）からのデータ取得とパース。
// ページは cname（末尾に 2 桁のチェック値付き）を POST して開く仕組みなので、
// URL を組み立てずにページ内のリンクを辿って取得する。
import * as cheerio from 'cheerio';

const BASE = 'https://www.jra.go.jp/JRADB/accessS.html';
const ROOT_CNAME = 'pw01skl00999999/B3'; // 過去レース結果検索（当月の開催一覧）
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const MIN_INTERVAL_MS = Number(process.env.UMAAPP_INTERVAL_MS || 2500);
// アクセス制限（503/429/403）を受けたときの待機時間（分）。待っても解除されなければエラー。
const BLOCK_WAIT_MIN = [2, 5, 10, 20, 30, 30];

export const VENUES = {
  '01': '札幌', '02': '函館', '03': '福島', '04': '新潟', '05': '東京',
  '06': '中山', '07': '中京', '08': '京都', '09': '阪神', '10': '小倉',
};

/** 待機中などの状況を外部（同期ジョブの表示）へ知らせるためのフック */
export const hooks = { onWait: null };

let lastRequest = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sjis = new TextDecoder('shift_jis');

/**
 * ページ取得。cname を渡すと JRADB へ POST、url を渡すと GET。
 * @param {{ cname?: string, path?: string, url?: string }} target
 */
async function fetchPage(target, attempt = 1, blocked = 0) {
  if (typeof target === 'string') target = { cname: target };
  const label = target.cname || target.url;
  // 一定間隔 + ゆらぎ（機械的な等間隔アクセスを避ける）
  const wait = lastRequest + MIN_INTERVAL_MS * (0.8 + Math.random() * 0.6) - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequest = Date.now();
  let res;
  try {
    res = target.url
      ? await fetch(target.url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja' } })
      : await fetch(target.path ? `https://www.jra.go.jp/JRADB/${target.path}` : BASE, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Accept-Language': 'ja', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ cname: target.cname }),
      });
  } catch (e) {
    if (attempt < 3) { await sleep(5000 * attempt); return fetchPage(target, attempt + 1, blocked); }
    throw e;
  }
  if ([503, 429, 403].includes(res.status) && blocked < BLOCK_WAIT_MIN.length) {
    const min = BLOCK_WAIT_MIN[blocked];
    const until = new Date(Date.now() + min * 60e3).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    hooks.onWait?.(`JRA サイトから一時的にアクセスを制限されています（HTTP ${res.status}）。${until} 頃に再開します`);
    await sleep(min * 60e3);
    hooks.onWait?.(null);
    return fetchPage(target, attempt, blocked + 1);
  }
  if (!res.ok) {
    if (attempt < 3 && res.status >= 500) { await sleep(5000 * attempt); return fetchPage(target, attempt + 1, blocked); }
    throw new Error(`HTTP ${res.status}: ${label}`);
  }
  const html = sjis.decode(Buffer.from(await res.arrayBuffer()));
  if (/パラメータエラー|不正なアクセス/.test(html.slice(0, 5000)) && !html.includes('race_result')) {
    throw new Error(`JRA サイトがページを返しませんでした: ${label}`);
  }
  return html;
}

// 騎手・調教師のプロフィール（読み仮名用）
const PEOPLE = {
  jockey: { meikan: 'https://www.jra.go.jp/datafile/meikan/jockey.html', path: 'accessK.html', list: /pw04knl[0-9A-Z]+\/[0-9A-F]{2}/g, profile: /pw04kmk(\d+)\/[0-9A-F]{2}/ },
  trainer: { meikan: 'https://www.jra.go.jp/datafile/meikan/trainer.html', path: 'accessC.html', list: /pw05cnl[0-9A-Z]+\/[0-9A-F]{2}/g, profile: /pw05cmk(\d+)\/[0-9A-F]{2}/ },
};

/** 現役の騎手・調教師の一覧（名鑑の五十音別ページを辿る）→ [{ id, name, cname }] */
export async function fetchPeopleList(kind) {
  const P = PEOPLE[kind];
  const index = await fetchPage({ url: P.meikan });
  const pages = [...new Set(index.match(P.list) || [])];
  const people = new Map();
  for (const cname of pages) {
    const $ = cheerio.load(await fetchPage({ cname, path: P.path }));
    $('a[onclick]').each((_, a) => {
      const m = ($(a).attr('onclick') || '').match(P.profile);
      if (!m) return;
      const id = m[1].slice(-5);
      people.set(id, { id, name: nospace($(a).find('.txt').text() || $(a).text()), cname: m[0] });
    });
  }
  return [...people.values()];
}

/** プロフィールページから読み仮名（カタカナ・空白なし）。見つからなければ '' */
export async function fetchKana(kind, cname) {
  const html = await fetchPage({ cname, path: PEOPLE[kind].path });
  const kana = cheerio.load(html)('.kana').first().text();
  return nospace(kana).replace(/[（）()・]/g, '');
}

const ymd = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

/**
 * 月の開催一覧ページ。cname 省略時は当月。
 * @returns {{ meetings: Array, months: Record<string,string> }}
 *   meetings: その月の開催（場・回・日ごと）、months: ページ内にある他の月へのリンク { '2026-10': cname }
 */
export async function fetchMonth(cname = ROOT_CNAME) {
  const html = await fetchPage(cname);
  const meetings = new Map();
  for (const m of html.matchAll(/pw01srl10(\d{2})(\d{4})(\d{2})(\d{2})(\d{8})\/[0-9A-F]{2}/g)) {
    const [c, venue, year, kai, day, date] = m;
    if (!VENUES[venue]) continue;
    const key = `${year}${venue}${kai}${day}`;
    meetings.set(key, { key, cname: c, venue_code: venue, venue: VENUES[venue], kai: +kai, day: +day, date: ymd(date) });
  }
  const months = {};
  for (const m of html.matchAll(/pw01skl10(\d{4})(\d{2})\/[0-9A-F]{2}/g)) months[`${m[1]}-${m[2]}`] = m[0];
  return { meetings: [...meetings.values()], months };
}

/** 開催日（場ごと）のレース選択ページ → 全レース一覧ページの cname とレース数 */
export async function fetchMeeting(srlCname) {
  const html = await fetchPage(srlCname);
  // pw01ses10 + 場(2) + 年(4) + 回(2) + 日(2) + 日付(8)
  const ses = html.match(/pw01ses10\d{18}\/[0-9A-F]{2}/)?.[0] ?? null;
  const races = new Set([...html.matchAll(/pw01sde10\d{10}(\d{2})\d{8}\//g)].map((m) => m[1]));
  return { sesCname: ses, raceCount: races.size };
}

const norm = (s) => String(s ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const nospace = (s) => norm(s).replace(/\s/g, '');
const intOrNull = (s) => { const v = parseInt(String(s ?? '').replace(/,/g, ''), 10); return Number.isFinite(v) ? v : null; };

/**
 * 全レース一覧ページ（1 開催日・1 場の全レース結果と払戻）をパース。
 * 結果が出ていないレースは含めない。
 */
export async function fetchMeetingResults(sesCname, meeting) {
  const html = await fetchPage(sesCname);
  const $ = cheerio.load(html);
  const out = [];
  $('.race_result_unit').each((_, unitEl) => {
    const unit = $(unitEl);
    const raceNo = intOrNull(unit.attr('id')?.match(/race_result_(\d+)R/)?.[1]);
    if (!raceNo) return;

    const entries = [];
    const people = []; // 騎手・調教師のプロフィールページ（読み仮名取得用）
    unit.find('table tbody tr').each((_, tr) => {
      const row = $(tr);
      const placeTd = row.children('td.place');
      if (!placeTd.length) return;
      const finish = nospace(placeTd.text());
      const jockeyTd = row.children('td.jockey');
      const jockeyA = jockeyTd.find('a').first();
      const trainerA = row.children('td.trainer').find('a').first();
      const horseA = row.children('td.horse').find('a').first();
      const code = (el, re) => (el.attr('onclick') || el.attr('href') || '').match(re)?.[1] ?? null;
      for (const [kind, a] of [['jockey', jockeyA], ['trainer', trainerA]]) {
        const m = (a.attr('onclick') || '').match(PEOPLE[kind].profile);
        if (m) people.push({ kind, id: m[1].slice(-5), name: nospace(a.text()), cname: m[0] });
      }
      entries.push({
        horse_no: intOrNull(row.children('td.num').text()),
        frame_no: intOrNull(row.children('td.waku').find('img').attr('alt')?.match(/\d+/)?.[0]),
        finish,
        finish_num: /^\d+/.test(finish) ? parseInt(finish, 10) : null,
        horse_id: code(horseA, /pw01dud10(\d{10})/),
        horse_name: nospace(horseA.text() || row.children('td.horse').text()),
        sex_age: nospace(row.children('td.age').text()),
        weight_carried: parseFloat(row.children('td.weight').text()) || null,
        jockey_id: code(jockeyA, /pw04kmk(\d+)\//)?.slice(-5) ?? null,
        jockey_name: nospace(jockeyA.text() || jockeyTd.clone().children('.mark').remove().end().text()),
        trainer_id: code(trainerA, /pw05cmk(\d+)\//)?.slice(-5) ?? null,
        trainer_name: nospace(trainerA.text() || row.children('td.trainer').text()) || null,
        odds: null,
        popularity: intOrNull(row.children('td.pop').text()),
        horse_weight: nospace(row.children('td.h_weight').text()) || null,
      });
    });
    // 結果未確定（発走前）のレースはスキップ
    if (!entries.length || !entries.some((e) => e.finish_num != null)) return;

    const payouts = [];
    unit.find('.refund_area li > dl').each((_, dl) => {
      const type = nospace($(dl).children('dt').text());
      $(dl).find('.line').each((_, line) => {
        const l = $(line);
        const combination = nospace(l.find('.num').text()).replace(/[→\-ー－]/g, '-');
        const amount = intOrNull(l.find('.yen').text());
        if (!type || !combination || amount == null) return;
        payouts.push({ bet_type: type, combination, amount, popularity: intOrNull(l.find('.pop').text()) });
      });
    });
    // 公式ページの成績表には単勝オッズ列が無いため、勝ち馬のみ払戻金から算出
    for (const p of payouts) {
      if (p.bet_type !== '単勝') continue;
      const e = entries.find((x) => String(x.horse_no) === p.combination);
      if (e) e.odds = p.amount / 100;
    }

    const typeCell = (c) => nospace(unit.find(`.race_title .type .cell.${c}`).first().text());
    // 格付けはアイコン画像の alt（「GⅠ」「J・GⅡ」「リステッド」など）→ 'G1' 'JG2' 'L'
    const gradeAlt = norm(unit.find('.race_title .race_name .grade_icon img').first().attr('alt'));
    const g = gradeAlt.replace(/[・\s]/g, '').match(/^(J?)G(I{1,3})$/);
    const grade = g ? `${g[1]}G${g[2].length}` : /リステッド/.test(gradeAlt) ? 'L' : null;
    const courseText = norm(unit.find('.race_title .cell.course').first().text());
    const name = nospace(unit.find('.race_title .race_name').first().text()) || null;
    const category = typeCell('category');
    const isJump = /障害/.test(`${category}${name}`);
    const surface = isJump ? '障' : /ダート/.test(courseText) ? 'ダ' : /芝/.test(courseText) ? '芝' : null;
    const baba = unit.find('.cell.baba li');
    out.push({
      race: {
        race_id: `${meeting.key}${String(raceNo).padStart(2, '0')}`, // 年+場+回+日+R
        date: meeting.date,
        venue_code: meeting.venue_code,
        venue: meeting.venue,
        race_no: raceNo,
        name,
        surface,
        distance: intOrNull(courseText.match(/([\d,]+)\s*メートル/)?.[1]),
        weather: nospace(baba.filter('.weather').find('.txt').text()) || null,
        track_condition: nospace(baba.not('.weather').first().find('.txt').text()) || null,
        class_text: [category, typeCell('class'), typeCell('rule'), typeCell('weight')].filter(Boolean).join(' ') || null,
        grade,
        headcount: entries.length,
      },
      entries,
      payouts,
      people,
    });
  });
  return out;
}
