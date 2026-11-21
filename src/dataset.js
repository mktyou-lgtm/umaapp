// ブラウザ内で計算するためのデータ（data.json と同じ形）を DB から組み立てる。
// 静的サイトの書き出し（scripts/export.js）と、PC 版の出馬表画面（/api/dataset）で共通。
import { db } from './db.js';
import { classOf } from '../public/sim.js';
import { trainModel } from '../public/model.js';

export function buildDataset({ train = true } = {}) {
  const races = db.prepare(`SELECT race_id, date, venue, race_no, name, surface, distance, headcount, track_condition, class_text, grade
    FROM races ORDER BY date, race_id`).all();
  const raceIndex = new Map(races.map((r, i) => [r.race_id, i]));

  // 名前は ID → 名前 の辞書にまとめてサイズを抑える（ID が無い場合は名前を ID 代わりにする）
  const names = { j: {}, t: {}, h: {} };
  const idOf = (dict, id, name) => {
    if (!id && !name) return null;
    const key = id || `n:${name}`;
    dict[key] ??= name;
    return key;
  };

  const entries = db.prepare(`SELECT race_id, horse_no, frame_no, finish, horse_id, horse_name, jockey_id, jockey_name,
      trainer_id, trainer_name, popularity, odds, weight_carried, time_sec, last3f, corner, sex_age, horse_weight FROM entries`).all()
    .filter((e) => raceIndex.has(e.race_id))
    .map((e) => {
      const corners = (e.corner || '').split('-').map(Number).filter((v) => v > 0);
      return [
        raceIndex.get(e.race_id), e.horse_no, e.finish,
        idOf(names.h, e.horse_id, e.horse_name), idOf(names.j, e.jockey_id, e.jockey_name),
        idOf(names.t, e.trainer_id, e.trainer_name), e.popularity, e.odds, e.frame_no, e.weight_carried,
        // 予想モデル用: 走破タイム・推定上り・最初と最後のコーナー通過順位・性齢・馬体重
        e.time_sec ?? null, e.last3f ?? null, corners[0] ?? null, corners.at(-1) ?? null,
        e.sex_age || null, parseInt(e.horse_weight, 10) || null,
      ];
    });

  // 単勝（0）と複勝（1）の払戻だけを書き出す
  const payouts = db.prepare(`SELECT race_id, bet_type, combination, amount FROM payouts WHERE bet_type IN ('単勝', '複勝')`).all()
    .filter((p) => raceIndex.has(p.race_id) && /^\d+$/.test(p.combination))
    .map((p) => [raceIndex.get(p.race_id), p.bet_type === '複勝' ? 1 : 0, Number(p.combination), p.amount]);

  // 出馬表（これから行われるレース）
  const cardRaces = db.prepare(`SELECT race_id, date, venue, race_no, name, surface, distance, class_text, grade, post_time, headcount, fetched_at
    FROM cards ORDER BY date, venue_code, race_no`).all();
  const cardIndex = new Map(cardRaces.map((r, i) => [r.race_id, i]));
  const cardEntries = db.prepare(`SELECT race_id, horse_no, frame_no, horse_id, horse_name, sex_age, weight_carried,
      jockey_id, jockey_name, trainer_id, trainer_name, odds, status FROM card_entries ORDER BY race_id, seq`).all()
    .filter((e) => cardIndex.has(e.race_id))
    .map((e) => [
      cardIndex.get(e.race_id), e.horse_no, e.frame_no,
      idOf(names.h, e.horse_id, e.horse_name), idOf(names.j, e.jockey_id, e.jockey_name),
      idOf(names.t, e.trainer_id, e.trainer_name), e.sex_age, e.weight_carried, e.odds, e.status,
    ]);

  // 騎手・調教師の読み仮名（ひらがな検索用）
  names.jk = {};
  names.tk = {};
  for (const p of db.prepare("SELECT kind, id, kana FROM people WHERE kana IS NOT NULL AND kana != ''").all()) {
    const dict = p.kind === 'jockey' ? names.jk : names.tk;
    if ((p.kind === 'jockey' ? names.j : names.t)[p.id] !== undefined) dict[p.id] = p.kana;
  }

  const data = {
    generatedAt: new Date().toISOString(),
    firstDate: races[0]?.date ?? null,
    lastDate: races.at(-1)?.date ?? null,
    // クラスは区分キー（新馬・未勝利…重賞）に変換して書き出す
    races: races.map((r) => [r.race_id, r.date, r.venue, r.race_no, r.name, r.surface, r.distance, r.headcount,
      r.track_condition, classOf(r.class_text, r.grade), r.grade]),
    names,
    entries,
    payouts,
    cards: {
      fetchedAt: cardRaces.reduce((a, r) => (r.fetched_at > a ? r.fetched_at : a), '') || null,
      races: cardRaces.map((r) => [r.race_id, r.date, r.venue, r.race_no, r.name, r.surface, r.distance,
        classOf(r.class_text, r.grade), r.grade, r.post_time, r.headcount]),
      entries: cardEntries,
    },
  };
  // 勝率予測モデル（学習と検証結果）
  // 券種ごとの検証用に全券種の払戻を渡す（data.json には書き出さない）
  const allPayouts = db.prepare('SELECT race_id, bet_type, combination, amount FROM payouts').all()
    .map((p) => [p.race_id, p.bet_type, p.combination, p.amount]);
  data.model = train ? trainModel(data, { payouts: allPayouts }) : null;
  return data;
}

// PC 版用のキャッシュ（DB が更新されたら作り直す）
let cache = { key: null, json: null };
export function datasetJson() {
  const key = JSON.stringify(db.prepare(`SELECT (SELECT COUNT(*) FROM races) r, (SELECT MAX(fetched_at) FROM races) rf,
    (SELECT MAX(fetched_at) FROM cards) cf, (SELECT COUNT(*) FROM cards) c, (SELECT COUNT(*) FROM people WHERE kana IS NOT NULL) k`).get());
  if (cache.key !== key) cache = { key, json: JSON.stringify(buildDataset()) };
  return cache.json;
}
