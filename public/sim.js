// 収支計算の共通ロジック（サーバーとブラウザの両方で使う）

export const BET_TYPES = ['単勝', '複勝'];
export const KIND_LABELS = { jockey: '騎手', trainer: '調教師', horse: '馬' };

/** 「Ｃ．ルメール」「C.ルメール」→「ルメール」のように正規化（部分一致検索用） */
export function normalizeName(s) {
  return String(s || '').normalize('NFKC').replace(/\s+/g, '').replace(/^[A-Za-z]\.(?=\S)/, '');
}

/** 取消・除外は馬券が返還されるので購入対象外（中止・失格はハズレ） */
export const isRefunded = (finish) => /取消|除外|取|除/.test(finish || '');

export const roundStake = (stake) => Math.max(100, Math.round(Number(stake) / 100) * 100 || 100);

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
  const races = data.races.map(([race_id, date, venue, race_no, name, surface, distance, headcount]) =>
    ({ race_id, date, venue, race_no, race_name: name, surface, distance, headcount }));
  const pay = { 単勝: new Map(), 複勝: new Map() };
  for (const [ri, type, horseNo, amount] of data.payouts) pay[type ? '複勝' : '単勝'].set(`${ri}:${horseNo}`, amount);
  const N = data.names;
  const entries = data.entries.map(([ri, horse_no, finish, horse_id, jockey_id, trainer_id, popularity, odds]) => ({
    ri, horse_no, finish, finish_num: /^\d+/.test(finish) ? parseInt(finish, 10) : null,
    horse_id, jockey_id, trainer_id, popularity, odds,
  }));
  const ID = { jockey: 'jockey_id', trainer: 'trainer_id', horse: 'horse_id' };
  const NAMES = { jockey: N.j, trainer: N.t, horse: N.h };
  const inRange = (e, from, to) => { const d = races[e.ri].date; return d >= from && d <= to; };

  return {
    meta: { generatedAt: data.generatedAt, firstDate: data.firstDate, lastDate: data.lastDate, races: races.length },

    candidates(kind, q, from, to) {
      const key = ID[kind], names = NAMES[kind];
      const name = normalizeName(q);
      if (!key || !name) return [];
      const counts = new Map();
      for (const e of entries) {
        const id = e[key];
        if (id == null || !inRange(e, from, to)) continue;
        if (!String(names[id] ?? '').replace(/\s/g, '').includes(name)) continue;
        counts.set(id, (counts.get(id) || 0) + 1);
      }
      return [...counts].map(([id, rides]) => ({ id, name: names[id], rides })).sort((a, b) => b.rides - a.rides).slice(0, 20);
    },

    simulate({ kind, id, from, to, bet = '単勝', stake = 100 }) {
      const key = ID[kind];
      if (!key) throw new Error('kind が不正です');
      if (!BET_TYPES.includes(bet)) throw new Error('券種が不正です');
      stake = roundStake(stake);
      const rows = entries
        .filter((e) => e[key] === id && inRange(e, from, to))
        .sort((a, b) => (races[a.ri].date + races[a.ri].race_id).localeCompare(races[b.ri].date + races[b.ri].race_id))
        .map((e) => ({
          ...races[e.ri], horse_no: e.horse_no, horse_name: N.h[e.horse_id], jockey_name: N.j[e.jockey_id],
          trainer_name: N.t[e.trainer_id], finish: e.finish, finish_num: e.finish_num, odds: e.odds,
          popularity: e.popularity, payout100: pay[bet].get(`${e.ri}:${e.horse_no}`) ?? null,
        }));
      return { kind, kindLabel: KIND_LABELS[kind], id, name: NAMES[kind][id] ?? null, from, to, bet, stakePerBet: stake, ...summarize(rows, stake) };
    },
  };
}
