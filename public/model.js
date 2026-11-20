// 勝率予測モデル（ブラウザと Node の両方で使う）
//
// 各出走馬のスコア s = w・x をレース内で softmax して勝率にする（条件付きロジット）。
//   能力モデル（fundamental）: 騎手・調教師・馬の過去成績などから
//   総合モデル（combined）    : 上に「オッズから見た勝率」を加えたもの
// 特徴量は、そのレースより前（前日まで）のデータだけで計算する。学習・検証も同じ方法で行う。
import { distBand, isRefunded } from './sim.js';

export const FEATURES = [
  { key: 'j_win', label: '騎手の勝率' },
  { key: 'j_cond', label: '騎手の同コース・距離の勝率' },
  { key: 't_win', label: '調教師の勝率' },
  { key: 'h_runs', label: '馬の出走数' },
  { key: 'h_debut', label: '初出走' },
  { key: 'h_win', label: '馬の勝率' },
  { key: 'h_place', label: '馬の複勝率' },
  { key: 'h_last', label: '前走の着順（頭数比）' },
  { key: 'h_avg3', label: '近 3 走の平均着順（頭数比）' },
  { key: 'h_cond', label: '馬の同コース・距離の複勝率' },
  { key: 'h_rest', label: '前走からの間隔' },
  { key: 'w_diff', label: '斤量（レース平均との差）' },
  { key: 'frame', label: '枠' },
];
export const MARKET = { key: 'm_logp', label: 'オッズから見た勝率' };

const logit = (p) => Math.log(p / (1 - p));
const shrink = (hits, n, prior, k) => (hits + k * prior) / (n + k); // 件数が少ないほど prior に寄せる
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const P_WIN = 0.07, P_PLACE = 0.21; // 平均的な勝率・複勝率（1 レース約 14 頭）

/** 騎手・調教師・馬の成績をレース順に積み上げていく */
class Tracker {
  constructor() { this.j = new Map(); this.t = new Map(); this.h = new Map(); }

  features(race, r) {
    const cond = `${race.surface}|${distBand(race.distance)}`;
    const J = this.j.get(r.jockey_id) || { n: 0, w: 0, c: {} };
    const jw = shrink(J.w, J.n, P_WIN, 30);
    const jc = J.c[cond] || { n: 0, w: 0 };
    const T = this.t.get(r.trainer_id) || { n: 0, w: 0 };
    const H = this.h.get(r.horse_id) || { n: 0, w: 0, p: 0, last: [], lastDate: null, c: {} };
    const hp = shrink(H.p, H.n, P_PLACE, 5);
    const hc = H.c[cond] || { n: 0, p: 0 };
    const days = H.lastDate ? Math.min(365, (Date.parse(race.date) - Date.parse(H.lastDate)) / 864e5) : 60;
    return {
      j_win: logit(jw),
      j_cond: logit(shrink(jc.w, jc.n, jw, 20)),
      t_win: logit(shrink(T.w, T.n, P_WIN, 30)),
      h_runs: Math.log1p(H.n),
      h_debut: H.n ? 0 : 1,
      h_win: logit(shrink(H.w, H.n, P_WIN, 5)),
      h_place: logit(hp),
      h_last: H.last.length ? H.last.at(-1) : 0.5,
      h_avg3: H.last.length ? mean(H.last.slice(-3)) : 0.5,
      h_cond: logit(shrink(hc.p, hc.n, hp, 3)),
      h_rest: Math.log1p(days),
      frame: r.frame_no ? (r.frame_no - 4.5) / 3.5 : 0,
    };
  }

  update(race, r) {
    if (isRefunded(r.finish)) return;
    const win = r.finish_num === 1 ? 1 : 0;
    const place = r.finish_num && r.finish_num <= 3 ? 1 : 0;
    const ratio = r.finish_num ? r.finish_num / race.headcount : 1; // 中止・失格は最下位扱い
    const cond = `${race.surface}|${distBand(race.distance)}`;
    const add = (map, id, init) => { let v = map.get(id); if (!v) map.set(id, (v = init())); return v; };
    if (r.jockey_id != null) {
      const J = add(this.j, r.jockey_id, () => ({ n: 0, w: 0, c: {} }));
      J.n++; J.w += win;
      const c = (J.c[cond] ||= { n: 0, w: 0 }); c.n++; c.w += win;
    }
    if (r.trainer_id != null) { const T = add(this.t, r.trainer_id, () => ({ n: 0, w: 0 })); T.n++; T.w += win; }
    if (r.horse_id != null) {
      const H = add(this.h, r.horse_id, () => ({ n: 0, w: 0, p: 0, last: [], lastDate: null, c: {} }));
      H.n++; H.w += win; H.p += place; H.last.push(ratio); if (H.last.length > 5) H.last.shift(); H.lastDate = race.date;
      const c = (H.c[cond] ||= { n: 0, p: 0 }); c.n++; c.p += place;
    }
  }
}

/** 1 レース分の特徴量（出走する馬だけ）。runners: [{ jockey_id, trainer_id, horse_id, frame_no, weight_carried, odds }] */
function raceRows(tracker, race, runners) {
  const ws = runners.map((r) => r.weight_carried).filter((v) => v > 0);
  const wMean = ws.length ? mean(ws) : 0;
  const allOdds = runners.every((r) => r.odds > 0);
  const inv = allOdds ? runners.reduce((s, r) => s + 1 / r.odds, 0) : 0;
  return runners.map((r) => {
    const x = tracker.features(race, r);
    x.w_diff = r.weight_carried > 0 && wMean ? r.weight_carried - wMean : 0;
    x.m_logp = allOdds ? Math.log((1 / r.odds) / inv) : null;
    x.p_mkt = allOdds ? (1 / r.odds) / inv : null;
    return x;
  });
}

/** data.json 形式のデータを日付順のレース（出走馬・結果つき）にまとめる */
function races(data) {
  const out = data.races.map(([race_id, date, venue, race_no, name, surface, distance, headcount]) =>
    ({ race_id, date, venue, race_no, name, surface, distance, headcount, runners: [] }));
  for (const [ri, horse_no, finish, horse_id, jockey_id, trainer_id, popularity, odds, frame_no, weight_carried] of data.entries) {
    out[ri].runners.push({
      horse_no, finish, finish_num: /^\d+/.test(finish) ? parseInt(finish, 10) : null,
      horse_id, jockey_id, trainer_id, popularity, odds, frame_no, weight_carried,
    });
  }
  const winPay = new Map();
  for (const [ri, type, horseNo, amount] of data.payouts) if (type === 0) winPay.set(`${ri}:${horseNo}`, amount);
  out.forEach((r, ri) => { for (const x of r.runners) x.payout = winPay.get(`${ri}:${x.horse_no}`) || 0; });
  return out;
}

/**
 * 全レースを日付順にたどり、各レースの特徴量を「その日より前のデータだけ」で作る。
 * 返り値: samples（出走馬の特徴量・勝ち馬・オッズ・払戻）と、最後まで積み上げた tracker
 */
function buildSamples(data) {
  const list = races(data);
  const tracker = new Tracker();
  const samples = [];
  let i = 0;
  while (i < list.length) {
    const date = list[i].date;
    let j = i;
    while (j < list.length && list[j].date === date) j++;
    const day = list.slice(i, j);
    for (const race of day) {
      const runners = race.runners.filter((r) => !isRefunded(r.finish));
      const winners = runners.map((r, k) => (r.finish_num === 1 ? k : -1)).filter((k) => k >= 0);
      if (runners.length < 2 || !winners.length) continue;
      samples.push({ race_id: race.race_id, date, rows: raceRows(tracker, race, runners), winners, runners });
    }
    for (const race of day) for (const r of race.runners) tracker.update(race, r);
    i = j;
  }
  return { samples, tracker };
}

/** 条件付きロジットの学習（Adam・L2 正則化） */
function fit(samples, keys, stdz, { iters = 400, lr = 0.05, l2 = 1e-3 } = {}) {
  const d = keys.length;
  const X = samples.map((s) => s.rows.map((x) => keys.map((k, c) => (x[k] - stdz.mean[c]) / stdz.std[c])));
  const w = new Float64Array(d), m = new Float64Array(d), v = new Float64Array(d);
  for (let it = 1; it <= iters; it++) {
    const g = new Float64Array(d);
    samples.forEach((s, si) => {
      const xs = X[si];
      const sc = xs.map((x) => x.reduce((a, xv, c) => a + xv * w[c], 0));
      const mx = Math.max(...sc);
      const ex = sc.map((z) => Math.exp(z - mx));
      const Z = ex.reduce((a, b) => a + b, 0);
      const y = new Float64Array(xs.length);
      for (const k of s.winners) y[k] = 1 / s.winners.length;
      xs.forEach((x, k) => { const diff = ex[k] / Z - y[k]; for (let c = 0; c < d; c++) g[c] += diff * x[c]; });
    });
    for (let c = 0; c < d; c++) {
      const gc = g[c] / samples.length + l2 * w[c];
      m[c] = 0.9 * m[c] + 0.1 * gc;
      v[c] = 0.999 * v[c] + 0.001 * gc * gc;
      w[c] -= (lr * (m[c] / (1 - 0.9 ** it))) / (Math.sqrt(v[c] / (1 - 0.999 ** it)) + 1e-8);
    }
  }
  return [...w];
}

function standardize(samples, keys) {
  const mean_ = keys.map((k) => mean(samples.flatMap((s) => s.rows.map((x) => x[k]))));
  const std = keys.map((k, c) => {
    const vals = samples.flatMap((s) => s.rows.map((x) => x[k]));
    const sd = Math.sqrt(mean(vals.map((v) => (v - mean_[c]) ** 2)));
    return sd > 1e-9 ? sd : 1;
  });
  return { mean: mean_, std };
}

/** レース内の勝率 */
export function probs(rows, part) {
  const sc = rows.map((x) => part.keys.reduce((a, k, c) => a + ((x[k] - part.mean[c]) / part.std[c]) * part.w[c], 0));
  const mx = Math.max(...sc);
  const ex = sc.map((z) => Math.exp(z - mx));
  const Z = ex.reduce((a, b) => a + b, 0);
  return ex.map((e) => e / Z);
}

function trainPart(samples, keys) {
  const stdz = standardize(samples, keys);
  return { keys, mean: stdz.mean, std: stdz.std, w: fit(samples, keys, stdz) };
}

const round = (v, n = 4) => Math.round(v * 10 ** n) / 10 ** n;

/** 検証用の集計 */
function evaluate(test, fund, comb) {
  const ll = { uniform: 0, market: 0, fundamental: 0, combined: 0 };
  const top = { market: 0, fundamental: 0, combined: 0 };
  const cal = [0, 0.05, 0.1, 0.2, 0.3, 0.5, 1.01].slice(0, -1).map((lo, i, a) => ({ lo, hi: [0.05, 0.1, 0.2, 0.3, 0.5, 1.01][i], n: 0, pred: 0, wins: 0 }));
  const ths = [1.0, 1.1, 1.2, 1.5, 2.0];
  const roi = ths.map((th) => ({ th, bets: 0, hits: 0, ret: 0 }));
  const roiFund = ths.map((th) => ({ th, bets: 0, hits: 0, ret: 0 }));
  const base = { all: { bets: 0, ret: 0 }, favorite: { bets: 0, ret: 0 }, combinedTop: { bets: 0, ret: 0 } };
  for (const s of test) {
    const pf = probs(s.rows, fund), pc = probs(s.rows, comb), pm = s.rows.map((x) => x.p_mkt);
    const n = s.rows.length;
    const lw = (p) => -mean(s.winners.map((k) => Math.log(Math.max(p[k], 1e-12))));
    ll.uniform += Math.log(n); ll.market += lw(pm); ll.fundamental += lw(pf); ll.combined += lw(pc);
    const argmax = (p) => p.indexOf(Math.max(...p));
    const won = (k) => s.winners.includes(k);
    if (won(argmax(pm))) top.market++;
    if (won(argmax(pf))) top.fundamental++;
    if (won(argmax(pc))) top.combined++;
    s.runners.forEach((r, k) => {
      const b = cal.find((c) => pc[k] >= c.lo && pc[k] < c.hi);
      b.n++; b.pred += pc[k]; b.wins += won(k) ? 1 : 0;
      base.all.bets++; base.all.ret += r.payout;
      roi.forEach((x) => { if (pc[k] * r.odds >= x.th) { x.bets++; x.ret += r.payout; if (r.payout) x.hits++; } });
      roiFund.forEach((x) => { if (pf[k] * r.odds >= x.th) { x.bets++; x.ret += r.payout; if (r.payout) x.hits++; } });
    });
    const fav = argmax(pm); base.favorite.bets++; base.favorite.ret += s.runners[fav].payout;
    const ct = argmax(pc); base.combinedTop.bets++; base.combinedTop.ret += s.runners[ct].payout;
  }
  const R = test.length;
  const rec = (x) => ({ ...x, recovery: x.bets ? round(x.ret / (x.bets * 100)) : null });
  return {
    races: R,
    from: test[0]?.date ?? null,
    to: test.at(-1)?.date ?? null,
    logloss: Object.fromEntries(Object.entries(ll).map(([k, v]) => [k, round(v / R)])),
    topHit: Object.fromEntries(Object.entries(top).map(([k, v]) => [k, round(v / R)])),
    calibration: cal.map((c) => ({ lo: c.lo, hi: Math.min(1, c.hi), n: c.n, pred: c.n ? round(c.pred / c.n) : null, actual: c.n ? round(c.wins / c.n) : null })),
    roi: roi.map(rec),
    roiFundamental: roiFund.map(rec),
    baseline: Object.fromEntries(Object.entries(base).map(([k, x]) => [k, rec(x)])),
  };
}

/**
 * 学習と検証。直近 holdoutDays 日を検証用に残して学習 → 検証結果を集計 → 全期間で学習し直したものを本番用に返す。
 * 総合モデルは、全馬の確定オッズがあるレースだけで学習・検証する。
 */
export function trainModel(data, { holdoutDays = 60, warmupDays = 30 } = {}) {
  const { samples } = buildSamples(data);
  if (samples.length < 200) return null;
  const first = samples[0].date, last = samples.at(-1).date;
  const shift = (d, days) => new Date(Date.parse(d) + days * 864e5).toISOString().slice(0, 10);
  const warm = shift(first, warmupDays); // 最初の 1 か月は成績の積み上げが少ないので学習に使わない
  const cutoff = shift(last, -holdoutDays);
  const usable = samples.filter((s) => s.date >= warm);
  const withOdds = usable.filter((s) => s.rows.every((x) => x.m_logp != null));
  const fKeys = FEATURES.map((f) => f.key);
  const cKeys = [...fKeys, MARKET.key];

  const trainF = usable.filter((s) => s.date < cutoff);
  const trainC = withOdds.filter((s) => s.date < cutoff);
  const test = withOdds.filter((s) => s.date >= cutoff);
  let report = null;
  if (trainC.length >= 200 && test.length >= 50) {
    report = { ...evaluate(test, trainPart(trainF, fKeys), trainPart(trainC, cKeys)), trainRaces: trainC.length, trainFrom: trainC[0].date, trainTo: trainC.at(-1).date };
  }
  const fundamental = trainPart(usable, fKeys);
  const combined = withOdds.length >= 200 ? trainPart(withOdds, cKeys) : null;
  const round6 = (p) => p && ({ ...p, mean: p.mean.map((v) => round(v, 6)), std: p.std.map((v) => round(v, 6)), w: p.w.map((v) => round(v, 6)) });
  return {
    trainedAt: new Date().toISOString(),
    races: { all: usable.length, withOdds: withOdds.length },
    fundamental: round6(fundamental),
    combined: round6(combined),
    report,
  };
}

/**
 * 出馬表の 1 レースの勝率。runners: [{ jockey_id, trainer_id, horse_id, frame_no, weight_carried, odds, status }]
 * 取消・除外の馬は除いて計算。全馬のオッズがあれば総合モデル、無ければ能力モデル。
 * 返り値: runners と同じ順の [{ p, pFund, pMkt, ev }]（取消・除外は null）
 */
export function createPredictor(data, model) {
  const { tracker } = buildSamples(data); // 全データを積み上げた状態（＝出馬表のレースより前）
  return (race, runners) => {
    if (!model?.fundamental) return runners.map(() => null);
    const active = runners.map((r, i) => ({ r, i })).filter(({ r }) => !r.status);
    if (active.length < 2) return runners.map(() => null);
    const rows = raceRows(tracker, race, active.map(({ r }) => r));
    const pf = probs(rows, model.fundamental);
    const useComb = model.combined && rows.every((x) => x.m_logp != null);
    const pc = useComb ? probs(rows, model.combined) : null;
    const out = runners.map(() => null);
    active.forEach(({ r, i }, k) => {
      const p = useComb ? pc[k] : pf[k];
      out[i] = { p, pFund: pf[k], pMkt: rows[k].p_mkt, ev: r.odds ? p * r.odds : null, combined: useComb };
    });
    return out;
  };
}
