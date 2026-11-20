// SQLite のデータを静的サイト（GitHub Pages）用に書き出す。
// 使い方: npm run export  → site/ に public/ の画面と data/data.json を出力
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../src/db.js';
import { classOf } from '../public/sim.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'site');

rmSync(OUT, { recursive: true, force: true });
cpSync(join(ROOT, 'public'), OUT, { recursive: true });
mkdirSync(join(OUT, 'data'), { recursive: true });

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
    trainer_id, trainer_name, popularity, odds FROM entries`).all()
  .filter((e) => raceIndex.has(e.race_id))
  .map((e) => [
    raceIndex.get(e.race_id), e.horse_no, e.finish,
    idOf(names.h, e.horse_id, e.horse_name), idOf(names.j, e.jockey_id, e.jockey_name),
    idOf(names.t, e.trainer_id, e.trainer_name), e.popularity, e.odds, e.frame_no,
  ]);

// 単勝（0）と複勝（1）の払戻だけを書き出す
const payouts = db.prepare(`SELECT race_id, bet_type, combination, amount FROM payouts WHERE bet_type IN ('単勝', '複勝')`).all()
  .filter((p) => raceIndex.has(p.race_id) && /^\d+$/.test(p.combination))
  .map((p) => [raceIndex.get(p.race_id), p.bet_type === '複勝' ? 1 : 0, Number(p.combination), p.amount]);

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
};
const json = JSON.stringify(data);
writeFileSync(join(OUT, 'data', 'data.json'), json);
writeFileSync(join(OUT, '.nojekyll'), '');
console.log(`site/ に書き出しました: ${races.length} レース, ${entries.length} 出走, data.json ${(json.length / 1024 / 1024).toFixed(2)} MB`);
