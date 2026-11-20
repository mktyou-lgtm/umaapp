// 収支計算の共通ロジック（サーバーとブラウザの両方で使う）

export const BET_TYPES = ['単勝', '複勝'];
// コース: all = 両方（芝・ダート。障害レースも含む全レース）
export const SURFACES = { all: '両方', 芝: '芝', ダ: 'ダート', 障: '障害' };
export const matchSurface = (surface, filter) => !filter || filter === 'all' || surface === filter;
export const KIND_LABELS = { jockey: '騎手', trainer: '調教師', horse: '馬' };

/** ひらがな → カタカナ（1 文字ずつ対応するので文字位置は変わらない） */
export const toKatakana = (s) => String(s ?? '').replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
/** カタカナ → ひらがな（読み仮名の表示用） */
export const toHiragana = (s) => String(s ?? '').replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

/**
 * 部分一致検索用の正規化。
 * 「Ｃ．ルメール」「c.るめーる」→「ルメール」、空白・中黒は除去、ひらがなはカタカナに揃える。
 */
export function normalizeName(s) {
  return toKatakana(String(s || '').normalize('NFKC').replace(/[\s・]+/g, '').replace(/^[A-Za-z]\.(?=\S)/, ''));
}

/**
 * 候補の絞り込み。rows: [{ id, name, rides, kana? }]（kana はカタカナの読み）
 * 名前か読み仮名に入力文字（ひらがな・カタカナ・漢字）を含むものを、騎乗数の多い順に返す。
 * by: 'name'（名前で一致）| 'kana'（読みで一致）
 */
export function filterCandidates(rows, q, limit = 20) {
  const qn = normalizeName(q);
  if (!qn) return [];
  const out = [];
  for (const r of rows) {
    const by = normalizeName(r.name).includes(qn) ? 'name' : r.kana && r.kana.includes(qn) ? 'kana' : null;
    if (by) out.push({ id: r.id, name: r.name, rides: r.rides, kana: r.kana || null, by });
  }
  return out.sort((a, b) => b.rides - a.rides).slice(0, limit);
}

/** 取消・除外は馬券が返還されるので購入対象外（中止・失格はハズレ） */
export const isRefunded = (finish) => /取消|除外|取|除/.test(finish || '');

export const roundStake = (stake) => Math.max(100, Math.round(Number(stake) / 100) * 100 || 100);

// ---- 絞り込み・条件別成績の区分 ----
export const VENUE_LIST = ['札幌', '函館', '福島', '新潟', '東京', '中山', '中京', '京都', '阪神', '小倉'];
export const DIST_BANDS = [
  { key: 'short', label: '短距離（〜1400m）', min: 0, max: 1400 },
  { key: 'mile', label: 'マイル（1500〜1800m）', min: 1401, max: 1800 },
  { key: 'middle', label: '中距離（1900〜2400m）', min: 1801, max: 2400 },
  { key: 'long', label: '長距離（2500m〜）', min: 2401, max: Infinity },
];
export const POP_BANDS = [
  { key: '1', label: '1番人気', min: 1, max: 1 },
  { key: '2-3', label: '2〜3番人気', min: 2, max: 3 },
  { key: '4-6', label: '4〜6番人気', min: 4, max: 6 },
  { key: '7-9', label: '7〜9番人気', min: 7, max: 9 },
  { key: '10-', label: '10番人気以下', min: 10, max: Infinity },
];
export const CONDITIONS = ['良', '稍重', '重', '不良'];
export const CLASS_LIST = [
  { key: 'newcomer', label: '新馬' },
  { key: 'maiden', label: '未勝利' },
  { key: '1win', label: '1勝クラス' },
  { key: '2win', label: '2勝クラス' },
  { key: '3win', label: '3勝クラス' },
  { key: 'open', label: 'オープン特別（L含む）' },
  { key: 'graded', label: '重賞（G1〜G3）' },
];
// 絞り込みだけで使う追加の選択肢
export const CLASS_EXTRA = [{ key: 'g1', label: 'G1 のみ' }];

const band = (list, v) => (v == null ? null : list.find((b) => v >= b.min && v <= b.max)?.key ?? null);
export const distBand = (d) => band(DIST_BANDS, d);
export const popBand = (p) => band(POP_BANDS, p);
export function classOf(classText, grade) {
  if (/^J?G[123]$/.test(grade || '')) return 'graded';
  const t = classText || '';
  if (/新馬/.test(t)) return 'newcomer';
  if (/未勝利/.test(t)) return 'maiden';
  if (/1勝クラス/.test(t)) return '1win';
  if (/2勝クラス/.test(t)) return '2win';
  if (/3勝クラス/.test(t)) return '3win';
  if (/オープン/.test(t)) return 'open';
  return null;
}

/**
 * 絞り込み。f: { surface, venue, dist, pop, cond, cls }（'all' または未指定は絞り込まない）
 * rows の各要素は surface, venue, distance, popularity, track_condition, cls, grade を持つ。
 */
export function matchFilters(r, f = {}) {
  const on = (v) => v && v !== 'all';
  return matchSurface(r.surface, f.surface)
    && (!on(f.venue) || r.venue === f.venue)
    && (!on(f.dist) || distBand(r.distance) === f.dist)
    && (!on(f.pop) || popBand(r.popularity) === f.pop)
    && (!on(f.cond) || r.track_condition === f.cond)
    && (!on(f.cls) || (f.cls === 'g1' ? r.grade === 'G1' : r.cls === f.cls));
}
export const applyFilters = (rows, f = {}) => rows.filter((r) => matchFilters(r, f));

/**
 * 出馬表で使う「同じ条件」の範囲 → 絞り込み条件
 *   same: 同じ競馬場・コース・距離帯 / course: 同じコース・距離帯 / surface: 同じコース（芝・ダ）/ all: 全レース
 */
export const CARD_SCOPES = [
  { key: 'same', label: '同じ競馬場・コース・距離' },
  { key: 'course', label: '同じコース・距離' },
  { key: 'surface', label: '同じコース（芝/ダート）' },
  { key: 'all', label: '全レース' },
];
export function scopeFilters(race, scope) {
  if (scope === 'all') return {};
  const f = { surface: race.surface };
  if (scope === 'surface') return f;
  f.dist = distBand(race.distance);
  if (scope === 'same') f.venue = race.venue;
  return f;
}

/** 条件別の成績（返還は除く）。各区分: { label, bets, first, second, third, hits, stake, ret, profit, recovery, winRate, placeRate } */
export function breakdown(rows, stake) {
  const groups = {
    venue: { label: '競馬場', key: (r) => r.venue, order: VENUE_LIST.map((v) => ({ key: v, label: v })) },
    surface: { label: 'コース', key: (r) => r.surface, order: [{ key: '芝', label: '芝' }, { key: 'ダ', label: 'ダート' }, { key: '障', label: '障害' }] },
    dist: { label: '距離', key: (r) => distBand(r.distance), order: DIST_BANDS },
    pop: { label: '人気', key: (r) => popBand(r.popularity), order: POP_BANDS },
    cond: { label: '馬場状態', key: (r) => r.track_condition, order: CONDITIONS.map((c) => ({ key: c, label: c })) },
    cls: { label: 'クラス', key: (r) => r.cls, order: CLASS_LIST },
    frame: { label: '枠', key: (r) => r.frame_no, order: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ key: n, label: `${n}枠` })) },
  };
  const out = {};
  for (const [name, g] of Object.entries(groups)) {
    const acc = new Map();
    for (const r of rows) {
      if (isRefunded(r.finish)) continue;
      const k = g.key(r);
      if (k == null) continue;
      const a = acc.get(k) || { bets: 0, first: 0, second: 0, third: 0, hits: 0, stake: 0, ret: 0 };
      const ret = r.payout100 ? (r.payout100 * stake) / 100 : 0;
      a.bets++; a.stake += stake; a.ret += ret; if (ret > 0) a.hits++;
      if (r.finish_num === 1) a.first++; else if (r.finish_num === 2) a.second++; else if (r.finish_num === 3) a.third++;
      acc.set(k, a);
    }
    out[name] = {
      label: g.label,
      rows: g.order.filter((o) => acc.has(o.key)).map((o) => {
        const a = acc.get(o.key);
        return { key: o.key, label: o.label, ...a, profit: a.ret - a.stake, recovery: a.ret / a.stake,
          winRate: a.first / a.bets, placeRate: (a.first + a.second + a.third) / a.bets };
      }),
    };
  }
  return out;
}

/** 絞り込み → 集計 → 条件別成績 */
export function analyze(rows, filters, stake) {
  const filtered = applyFilters(rows, filters);
  return { ...summarize(filtered, stake), breakdown: breakdown(filtered, stake) };
}

/** 絞り込み条件の検証（不正な値は 'all' に戻す） */
export function cleanFilters(f = {}) {
  const ok = {
    surface: Object.keys(SURFACES),
    venue: VENUE_LIST,
    dist: DIST_BANDS.map((b) => b.key),
    pop: POP_BANDS.map((b) => b.key),
    cond: CONDITIONS,
    cls: [...CLASS_LIST, ...CLASS_EXTRA].map((c) => c.key),
  };
  return Object.fromEntries(Object.entries(ok).map(([k, list]) => [k, list.includes(f[k]) ? f[k] : 'all']));
}

/**
 * rows: 日付順の騎乗（出走）一覧。各要素は
 *   { date, finish, finish_num, payout100 (的中時の100円あたり払戻 or null), ...表示用の項目 }
 */
export function summarize(rows, stake) {
  const s = { bets: 0, refunded: 0, hits: 0, stake: 0, ret: 0, first: 0, second: 0, third: 0, maxPayout: 0 };
  const months = new Map();
  const series = [];
  const races = [];
  let cum = 0;

  for (const r of rows) {
    if (isRefunded(r.finish)) {
      s.refunded++;
      races.push({ ...r, status: 'refund', stake: 0, ret: 0 });
      continue;
    }
    const ret = r.payout100 ? (r.payout100 * stake) / 100 : 0;
    s.bets++;
    s.stake += stake;
    s.ret += ret;
    if (ret > 0) s.hits++;
    if (r.finish_num === 1) s.first++;
    else if (r.finish_num === 2) s.second++;
    else if (r.finish_num === 3) s.third++;
    s.maxPayout = Math.max(s.maxPayout, ret);
    cum += ret - stake;
    series.push({ date: r.date, cum });

    const ym = r.date.slice(0, 7);
    const m = months.get(ym) || { month: ym, bets: 0, hits: 0, stake: 0, ret: 0 };
    m.bets++; m.stake += stake; m.ret += ret; if (ret > 0) m.hits++;
    months.set(ym, m);
    races.push({ ...r, status: ret > 0 ? 'hit' : 'miss', stake, ret });
  }

  return {
    summary: {
      ...s,
      profit: s.ret - s.stake,
      recovery: s.stake ? s.ret / s.stake : null,
      hitRate: s.bets ? s.hits / s.bets : null,
    },
    months: [...months.values()].map((m) => ({ ...m, profit: m.ret - m.stake, recovery: m.stake ? m.ret / m.stake : null })),
    series,
    races: races.reverse(), // 新しい順
  };
}

/**
 * 静的版（GitHub Pages）用：書き出した data.json をブラウザ内で検索・計算する。
 * data.json の形式は scripts/export.js を参照。
 */
export function createStaticEngine(data) {
  const races = data.races.map(([race_id, date, venue, race_no, name, surface, distance, headcount, track_condition, cls, grade]) =>
    ({ race_id, date, venue, race_no, race_name: name, surface, distance, headcount, track_condition, cls, grade }));
  const pay = { 単勝: new Map(), 複勝: new Map() };
  for (const [ri, type, horseNo, amount] of data.payouts) pay[type ? '複勝' : '単勝'].set(`${ri}:${horseNo}`, amount);
  const N = data.names;
  const entries = data.entries.map(([ri, horse_no, finish, horse_id, jockey_id, trainer_id, popularity, odds, frame_no]) => ({
    ri, horse_no, finish, finish_num: /^\d+/.test(finish) ? parseInt(finish, 10) : null,
    horse_id, jockey_id, trainer_id, popularity, odds, frame_no,
  }));
  const ID = { jockey: 'jockey_id', trainer: 'trainer_id', horse: 'horse_id' };
  const NAMES = { jockey: N.j, trainer: N.t, horse: N.h };
  const KANA = { jockey: N.jk || {}, trainer: N.tk || {}, horse: {} };

  // ID → 出走（古い順）の索引。races は日付順なので ri の昇順 = 日付順
  const index = { jockey: new Map(), trainer: new Map(), horse: new Map() };
  entries.forEach((e, i) => {
    for (const kind of ['jockey', 'trainer', 'horse']) {
      const id = e[ID[kind]];
      if (id == null) continue;
      let list = index[kind].get(id);
      if (!list) index[kind].set(id, (list = []));
      list.push(i);
    }
  });
  for (const m of Object.values(index)) for (const list of m.values()) list.sort((a, b) => entries[a].ri - entries[b].ri);

  /** 1 人（1 頭）の成績。返還は除く。回収率は単勝・複勝とも 100 円ずつ買った場合 */
  function stats(kind, id, { from = '0000-00-00', to = '9999-99-99', filters = {} } = {}) {
    const s = { runs: 0, first: 0, second: 0, third: 0, winRet: 0, placeRet: 0 };
    const f = cleanFilters(filters);
    for (const i of index[kind].get(id) || []) {
      const e = entries[i], r = races[e.ri];
      if (r.date < from || r.date > to || isRefunded(e.finish)) continue;
      if (!matchFilters({ ...r, popularity: e.popularity }, f)) continue;
      s.runs++;
      if (e.finish_num === 1) s.first++; else if (e.finish_num === 2) s.second++; else if (e.finish_num === 3) s.third++;
      s.winRet += pay.単勝.get(`${e.ri}:${e.horse_no}`) || 0;
      s.placeRet += pay.複勝.get(`${e.ri}:${e.horse_no}`) || 0;
    }
    const n = s.runs;
    return {
      runs: n, first: s.first, second: s.second, third: s.third,
      winRate: n ? s.first / n : null,
      placeRate: n ? (s.first + s.second + s.third) / n : null,
      winRecovery: n ? s.winRet / (n * 100) : null,
      placeRecovery: n ? s.placeRet / (n * 100) : null,
    };
  }

  /** 馬の近走（新しい順） */
  function form(horseId, beforeDate, n = 5) {
    const list = (index.horse.get(horseId) || []).filter((i) => races[entries[i].ri].date < beforeDate);
    return list.slice(-n).reverse().map((i) => {
      const e = entries[i], r = races[e.ri];
      return {
        date: r.date, venue: r.venue, race_name: r.race_name, surface: r.surface, distance: r.distance, grade: r.grade,
        headcount: r.headcount, finish: e.finish, finish_num: e.finish_num, popularity: e.popularity, jockey_name: N.j[e.jockey_id],
      };
    });
  }

  // 出馬表
  const C = data.cards || { races: [], entries: [] };
  const cardRaces = C.races.map(([race_id, date, venue, race_no, name, surface, distance, cls, grade, post_time, headcount]) =>
    ({ race_id, date, venue, race_no, race_name: name, surface, distance, cls, grade, post_time, headcount }));
  const cardEntries = new Map();
  for (const [ci, horse_no, frame_no, horse_id, jockey_id, trainer_id, sex_age, weight_carried, odds, status] of C.entries) {
    if (!cardEntries.has(ci)) cardEntries.set(ci, []);
    cardEntries.get(ci).push({ horse_no, frame_no, horse_id, jockey_id, trainer_id, sex_age, weight_carried, odds, status });
  }
  const dayBefore = (date, days) => new Date(Date.parse(date) - days * 864e5).toISOString().slice(0, 10);
  const inRange = (e, from, to) => { const d = races[e.ri].date; return d >= from && d <= to; };

  return {
    meta: {
      generatedAt: data.generatedAt, firstDate: data.firstDate, lastDate: data.lastDate, races: races.length,
      cardsFetchedAt: C.fetchedAt || null,
    },

    /** 出馬表のレース一覧 */
    cardList: () => cardRaces,

    /**
     * 出馬表 1 レース分と、出走馬ごとの騎手・調教師・馬の成績。
     * scope: CARD_SCOPES のキー（騎手・調教師・馬の「同条件」成績の範囲）、days: 集計期間（レース前日までの日数）
     */
    card(raceId, { scope = 'course', days = 365 } = {}) {
      const ci = cardRaces.findIndex((r) => r.race_id === raceId);
      if (ci < 0) return null;
      const race = cardRaces[ci];
      const range = { from: dayBefore(race.date, days), to: dayBefore(race.date, 1) };
      const filters = scopeFilters(race, scope);
      const runners = (cardEntries.get(ci) || []).map((e) => ({
        ...e,
        horse_name: N.h[e.horse_id], jockey_name: N.j[e.jockey_id], trainer_name: N.t[e.trainer_id],
        jockey: stats('jockey', e.jockey_id, { ...range, filters }),
        trainer: stats('trainer', e.trainer_id, { ...range, filters }),
        horse: stats('horse', e.horse_id, range),
        horseCond: stats('horse', e.horse_id, { ...range, filters }),
        form: form(e.horse_id, race.date),
      }));
      // 単勝オッズの順位（人気）
      const ranked = runners.filter((r) => r.odds && !r.status).sort((a, b) => a.odds - b.odds);
      ranked.forEach((r, i) => { r.pop = i + 1; });
      return { race, range, filters, scope, runners };
    },

    candidates(kind, q, from, to) {
      const key = ID[kind], names = NAMES[kind], kana = KANA[kind];
      if (!key || !normalizeName(q)) return [];
      const counts = new Map();
      for (const e of entries) {
        const id = e[key];
        if (id == null || !inRange(e, from, to)) continue;
        counts.set(id, (counts.get(id) || 0) + 1);
      }
      return filterCandidates([...counts].map(([id, rides]) => ({ id, name: names[id], rides, kana: kana[id] })), q);
    },

    simulate({ kind, id, from, to, bet = '単勝', stake = 100, ...filters }) {
      const key = ID[kind];
      if (!key) throw new Error('kind が不正です');
      if (!BET_TYPES.includes(bet)) throw new Error('券種が不正です');
      stake = roundStake(stake);
      const f = cleanFilters(filters);
      const rows = entries
        .filter((e) => e[key] === id && inRange(e, from, to))
        .sort((a, b) => (races[a.ri].date + races[a.ri].race_id).localeCompare(races[b.ri].date + races[b.ri].race_id))
        .map((e) => ({
          ...races[e.ri], horse_no: e.horse_no, frame_no: e.frame_no, horse_name: N.h[e.horse_id], jockey_name: N.j[e.jockey_id],
          trainer_name: N.t[e.trainer_id], finish: e.finish, finish_num: e.finish_num, odds: e.odds,
          popularity: e.popularity, payout100: pay[bet].get(`${e.ri}:${e.horse_no}`) ?? null,
        }));
      return { kind, kindLabel: KIND_LABELS[kind], id, name: NAMES[kind][id] ?? null, from, to, bet, filters: f, stakePerBet: stake, ...analyze(rows, f, stake) };
    },
  };
}
