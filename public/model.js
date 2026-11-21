// 勝率予測モデル（ブラウザと Node の両方で使う）
//
// 各出走馬のスコア s = w・x をレース内で softmax して勝率にする（条件付きロジット）。
//   能力モデル（fundamental）: 騎手・調教師・馬の過去成績などから
//   総合モデル（combined）    : 上に「オッズから見た勝率」を加えたもの
// 特徴量は、そのレースより前（前日まで）のデータだけで計算する。学習・検証も同じ方法で行う。
import { distBand, isRefunded } from './sim.js';

export const FEATURES = [
  { key: 'j_win', label: '騎手の勝率' },
  { key: 'j_recent', label: '騎手の最近の勝率（直近ほど重視）' },
  { key: 'j_cond', label: '騎手の同コース・距離の勝率' },
  { key: 't_win', label: '調教師の勝率' },
  { key: 'h_runs', label: '馬の出走数' },
  { key: 'h_debut', label: '初出走' },
  { key: 'h_win', label: '馬の勝率' },
  { key: 'h_place', label: '馬の複勝率' },
  { key: 'h_last', label: '前走の着順（頭数比）' },
  { key: 'h_avg3', label: '近 3 走の平均着順（頭数比）' },
  { key: 'h_cond', label: '馬の同コース・距離の複勝率' },
  { key: 'h_tdiff', label: '近 3 走の勝ち馬とのタイム差' },
  { key: 'h_tbest', label: '近 5 走で最も小さいタイム差' },
  { key: 'h_fig', label: '近 5 走の最高スピード指数' },
  { key: 'h_l3f', label: '近 3 走の上り 3F の順位（頭数比）' },
  { key: 'h_pos', label: '近 3 走の 4 コーナー位置（頭数比）' },
  { key: 'h_pop', label: '近 3 走の人気（頭数比）' },
  { key: 'cls_up', label: '前走からのクラスの上がり下がり' },
  { key: 'dist_chg', label: '前走からの距離の変化' },
  { key: 'surf_chg', label: '前走と芝・ダートが違う' },
  { key: 'h_rest', label: '前走からの間隔' },
  { key: 'age', label: '馬齢（レース平均との差）' },
  { key: 'female', label: '牝馬' },
  { key: 'w_diff', label: '斤量（レース平均との差）' },
  { key: 'frame', label: '枠' },
];
export const MARKET = { key: 'm_logp', label: 'オッズから見た勝率' };
// 人気薄ほどオッズが実力より低く付きやすい（穴馬の過剰人気）などの歪みを拾うための 2 乗項
export const MARKET2 = { key: 'm_logp2', label: 'オッズから見た勝率（2 乗項）' };

const logit = (p) => Math.log(p / (1 - p));
const shrink = (hits, n, prior, k) => (hits + k * prior) / (n + k); // 件数が少ないほど prior に寄せる
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const vals = (list, key, n) => list.slice(-n).map((h) => h[key]).filter((v) => v != null);
const avgOr = (a, d) => (a.length ? mean(a) : d);
const clip = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const P_WIN = 0.07, P_PLACE = 0.21; // 平均的な勝率・複勝率（1 レース約 14 頭）
const RECENT_DAYS = 45; // 騎手の「最近の勝率」の重みが半分になる日数
const CLASS_LEVEL = { newcomer: 0, maiden: 0, '1win': 1, '2win': 2, '3win': 3, open: 4, graded: 5 };
const condGroup = (c) => (/重|不/.test(c || '') ? 'h' : 'g'); // 良・稍重 / 重・不良
const ageOf = (sexAge) => parseInt(String(sexAge || '').replace(/^\D+/, ''), 10) || null;

/** 騎手・調教師・馬の成績をレース順に積み上げていく */
class Tracker {
  constructor() { this.j = new Map(); this.t = new Map(); this.h = new Map(); this.std = new Map(); }

  features(race, r) {
    const cond = `${race.surface}|${distBand(race.distance)}`;
    const J = this.j.get(r.jockey_id) || { n: 0, w: 0, c: {}, en: 0, ew: 0, date: null };
    const jw = shrink(J.w, J.n, P_WIN, 30);
    const jc = J.c[cond] || { n: 0, w: 0 };
    const decay = J.date ? 0.5 ** ((Date.parse(race.date) - Date.parse(J.date)) / 864e5 / RECENT_DAYS) : 0;
    const T = this.t.get(r.trainer_id) || { n: 0, w: 0 };
    const H = this.h.get(r.horse_id) || { n: 0, w: 0, p: 0, hist: [], c: {} };
    const hp = shrink(H.p, H.n, P_PLACE, 5);
    const hc = H.c[cond] || { n: 0, p: 0 };
    const last = H.hist.at(-1);
    const days = last ? Math.min(365, (Date.parse(race.date) - Date.parse(last.date)) / 864e5) : 60;
    const tdiffs = vals(H.hist, 'tdiff', 5);
    const figs = vals(H.hist, 'fig', 5);
    const lv = CLASS_LEVEL[race.cls], lvLast = last && CLASS_LEVEL[last.cls];
    return {
      j_win: logit(jw),
      j_recent: logit(shrink(J.ew * decay, J.en * decay, jw, 15)),
      j_cond: logit(shrink(jc.w, jc.n, jw, 20)),
      t_win: logit(shrink(T.w, T.n, P_WIN, 30)),
      h_runs: Math.log1p(H.n),
      h_debut: H.n ? 0 : 1,
      h_win: logit(shrink(H.w, H.n, P_WIN, 5)),
      h_place: logit(hp),
      h_last: last ? last.ratio : 0.5,
      h_avg3: avgOr(vals(H.hist, 'ratio', 3), 0.5),
      h_cond: logit(shrink(hc.p, hc.n, hp, 3)),
      h_tdiff: avgOr(vals(H.hist, 'tdiff', 3), 1.5),
      h_tbest: tdiffs.length ? Math.min(...tdiffs) : 1.5,
      h_fig: figs.length ? Math.max(...figs) : -1,
      h_l3f: avgOr(vals(H.hist, 'l3r', 3), 0.5),
      h_pos: avgOr(vals(H.hist, 'pos', 3), 0.5),
      h_pop: avgOr(vals(H.hist, 'pop', 3), 0.5),
      cls_up: lv != null && lvLast != null ? clip(lv - lvLast, -2, 2) : 0,
      dist_chg: last && race.distance && last.dist ? Math.min(3, Math.abs(race.distance - last.dist) / 400) : 0,
      surf_chg: last && last.surface !== race.surface ? 1 : 0,
      h_rest: Math.log1p(days),
      female: /牝/.test(r.sex_age || '') ? 1 : 0,
      frame: r.frame_no ? (r.frame_no - 4.5) / 3.5 : 0,
    };
  }

  /** 1 レースの結果を積み上げる（タイム差・上りの順位などはレース内で比べて作る） */
  updateRace(race) {
    const done = race.runners.filter((r) => !isRefunded(r.finish));
    const timed = done.filter((r) => r.finish_num && r.time_sec > 0);
    const winTime = timed.length ? Math.min(...timed.map((r) => r.time_sec)) : null;
    const l3 = done.filter((r) => r.last3f > 0).map((r) => r.last3f).sort((a, b) => a - b);
    const l3rank = (v) => (v > 0 && l3.length > 1 ? l3.indexOf(v) / (l3.length - 1) : null);
    // スピード指数: 同じ競馬場・コース・距離・馬場（良〜稍重／重〜不良）の勝ちタイムの平均と比べた速さ（1000m あたり秒）
    const stdKey = `${race.venue}|${race.surface}|${race.distance}|${condGroup(race.track_condition)}`;
    const S = this.std.get(stdKey) || { n: 0, sum: 0 };
    const stdTime = S.n >= 3 ? S.sum / S.n : null;
    const add = (map, id, init) => { let v = map.get(id); if (!v) map.set(id, (v = init())); return v; };
    const cond = `${race.surface}|${distBand(race.distance)}`;
    const n = done.length;
    for (const r of done) {
      const win = r.finish_num === 1 ? 1 : 0;
      const place = r.finish_num && r.finish_num <= 3 ? 1 : 0;
      if (r.jockey_id != null) {
        const J = add(this.j, r.jockey_id, () => ({ n: 0, w: 0, c: {}, en: 0, ew: 0, date: null }));
        const decay = J.date ? 0.5 ** ((Date.parse(race.date) - Date.parse(J.date)) / 864e5 / RECENT_DAYS) : 1;
        J.n++; J.w += win; J.en = J.en * decay + 1; J.ew = J.ew * decay + win; J.date = race.date;
        const c = (J.c[cond] ||= { n: 0, w: 0 }); c.n++; c.w += win;
      }
      if (r.trainer_id != null) { const T = add(this.t, r.trainer_id, () => ({ n: 0, w: 0 })); T.n++; T.w += win; }
      if (r.horse_id != null) {
        const H = add(this.h, r.horse_id, () => ({ n: 0, w: 0, p: 0, hist: [], c: {} }));
        H.n++; H.w += win; H.p += place;
        const t = r.finish_num && r.time_sec > 0 ? r.time_sec : null;
        H.hist.push({
          date: race.date,
          ratio: r.finish_num ? r.finish_num / race.headcount : 1, // 中止・失格は最下位扱い
          tdiff: t != null && winTime != null ? Math.min(4, t - winTime) : null,
          fig: t != null && stdTime != null && race.distance ? clip(((stdTime - t) / race.distance) * 1000, -3, 3) : null,
          l3r: l3rank(r.last3f),
          pos: r.corner_last && n ? r.corner_last / n : null,
          pop: r.popularity && n ? r.popularity / n : null,
          cls: race.cls, dist: race.distance, surface: race.surface,
        });
        if (H.hist.length > 5) H.hist.shift();
        const c = (H.c[cond] ||= { n: 0, p: 0 }); c.n++; c.p += place;
      }
    }
    if (winTime != null) { S.n++; S.sum += winTime; this.std.set(stdKey, S); }
  }
}

/** 1 レース分の特徴量（出走する馬だけ）。runners: [{ jockey_id, trainer_id, horse_id, frame_no, weight_carried, sex_age, odds }] */
function raceRows(tracker, race, runners) {
  const ws = runners.map((r) => r.weight_carried).filter((v) => v > 0);
  const wMean = ws.length ? mean(ws) : 0;
  const ages = runners.map((r) => ageOf(r.sex_age)).filter((v) => v);
  const aMean = ages.length ? mean(ages) : 0;
  const allOdds = runners.every((r) => r.odds > 0);
  const inv = allOdds ? runners.reduce((s, r) => s + 1 / r.odds, 0) : 0;
  return runners.map((r) => {
    const x = tracker.features(race, r);
    x.w_diff = r.weight_carried > 0 && wMean ? r.weight_carried - wMean : 0;
    const a = ageOf(r.sex_age);
    x.age = a && aMean ? clip(a - aMean, -3, 3) : 0;
    x.p_mkt = allOdds ? (1 / r.odds) / inv : null;
    x.m_logp = allOdds ? Math.log(x.p_mkt) : null;
    x.m_logp2 = allOdds ? x.m_logp ** 2 : null;
    return x;
  });
}

/** data.json 形式のデータを日付順のレース（出走馬・結果つき）にまとめる */
function races(data) {
  const out = data.races.map(([race_id, date, venue, race_no, name, surface, distance, headcount, track_condition, cls]) =>
    ({ race_id, date, venue, race_no, name, surface, distance, headcount, track_condition, cls, runners: [] }));
  for (const [ri, horse_no, finish, horse_id, jockey_id, trainer_id, popularity, odds, frame_no, weight_carried,
    time_sec, last3f, corner_first, corner_last, sex_age, body_weight] of data.entries) {
    out[ri].runners.push({
      horse_no, finish, finish_num: /^\d+/.test(finish) ? parseInt(finish, 10) : null,
      horse_id, jockey_id, trainer_id, popularity, odds, frame_no, weight_carried,
      time_sec, last3f, corner_first, corner_last, sex_age, body_weight,
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
    for (const race of day) tracker.updateRace(race);
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
function evaluate(test) {
  const ll = { uniform: 0, market: 0, fundamental: 0, combined: 0 };
  const top = { market: 0, fundamental: 0, combined: 0 };
  const cal = [0, 0.05, 0.1, 0.2, 0.3, 0.5, 1.01].slice(0, -1).map((lo, i, a) => ({ lo, hi: [0.05, 0.1, 0.2, 0.3, 0.5, 1.01][i], n: 0, pred: 0, wins: 0 }));
  const ths = [1.0, 1.1, 1.2, 1.5, 2.0];
  const roi = ths.map((th) => ({ th, bets: 0, hits: 0, ret: 0 }));
  const roiFund = ths.map((th) => ({ th, bets: 0, hits: 0, ret: 0 }));
  const base = { all: { bets: 0, ret: 0 }, favorite: { bets: 0, ret: 0 }, combinedTop: { bets: 0, ret: 0 } };
  for (const s of test) {
    const { pf, pc } = s, pm = s.rows.map((x) => x.p_mkt);
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

/** 能力モデルの勝率（対数）を各馬の特徴量 f_logp に書き込み、勝率を返す */
function withFund(rows, fund) {
  const p = probs(rows, fund);
  rows.forEach((x, k) => { x.f_logp = Math.log(Math.max(p[k], 1e-12)); });
  return p;
}

/** 能力モデルと総合モデルの勝率 */
function predictBoth(rows, fund, comb) {
  const pf = withFund(rows, fund);
  return { pf, pc: comb ? probs(rows, comb) : null };
}

/**
 * 総合モデルの学習。
 *   'stack': 能力モデルの勝率（対数）とオッズから見た勝率だけを組み合わせる（項目が少なく、学習データに合わせ込みすぎにくい）
 *   'full' : 全特徴量とオッズをまとめて学習
 */
function trainCombined(samples, fund, fKeys, market, mode) {
  if (mode === 'stack') {
    for (const s of samples) withFund(s.rows, fund);
    return trainPart(samples, ['f_logp', ...market]);
  }
  return trainPart(samples, [...fKeys, ...market]);
}

const shiftDate = (d, days) => new Date(Date.parse(d) + days * 864e5).toISOString().slice(0, 10);

/**
 * 学習と検証。
 * 検証は「その時点までのデータで学習 → 次の stepDays 日のレースを予想」を期間をずらしながら繰り返す
 * （各レースは必ず学習に使っていないモデルで予想される）。検証の後、全期間で学習し直したものを本番用に返す。
 * 総合モデルは、全馬の確定オッズがあるレースだけで学習・検証する。
 */
export function trainModel(data, {
  warmupDays = 30, stepDays = 28, minTrainRaces = 300,
  features = FEATURES.map((f) => f.key), market = [MARKET.key], mode = 'stack',
} = {}) {
  const { samples } = buildSamples(data);
  if (samples.length < 200) return null;
  const warm = shiftDate(samples[0].date, warmupDays); // 最初の 1 か月は成績の積み上げが少ないので学習に使わない
  const usable = samples.filter((s) => s.date >= warm);
  const withOdds = usable.filter((s) => s.rows.every((x) => x.m_logp != null));
  const fKeys = features;

  // 期間をずらしながらの検証
  let report = null;
  if (withOdds.length >= minTrainRaces + 50) {
    const tested = [];
    let folds = 0;
    const last = withOdds.at(-1).date;
    for (let d = withOdds[minTrainRaces].date; d <= last; d = shiftDate(d, stepDays)) {
      const end = shiftDate(d, stepDays);
      const test = withOdds.filter((s) => s.date >= d && s.date < end);
      if (!test.length) continue;
      const fund = trainPart(usable.filter((s) => s.date < d), fKeys);
      const comb = trainCombined(withOdds.filter((s) => s.date < d), fund, fKeys, market, mode);
      for (const s of test) Object.assign(s, predictBoth(s.rows, fund, comb));
      tested.push(...test);
      folds++;
    }
    report = { ...evaluate(tested), folds, stepDays, mode, trainFrom: withOdds[0].date };
  }
  const fundamental = trainPart(usable, fKeys);
  const combined = withOdds.length >= 200 ? trainCombined(withOdds, fundamental, fKeys, market, mode) : null;
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
    const useComb = model.combined && rows.every((x) => x.m_logp != null);
    const { pf, pc } = predictBoth(rows, model.fundamental, useComb ? model.combined : null);
    const out = runners.map(() => null);
    active.forEach(({ r, i }, k) => {
      const p = useComb ? pc[k] : pf[k];
      out[i] = { p, pFund: pf[k], pMkt: rows[k].p_mkt, ev: r.odds ? p * r.odds : null, combined: useComb };
    });
    return out;
  };
}
