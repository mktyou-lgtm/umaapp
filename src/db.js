import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = process.env.UMAAPP_DB || join(ROOT, 'data', 'jra.sqlite');
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
// 出馬表の明細は取り直せる一時データなので、形を変えたときは作り直す
try {
  const cols = db.prepare('PRAGMA table_info(card_entries)').all();
  if (cols.length && !cols.some((c) => c.name === 'seq')) db.exec('DROP TABLE card_entries');
} catch {}
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

-- JRA サイトの月別開催一覧ページ（cname はページを開くためのキー）
CREATE TABLE IF NOT EXISTS months (
  ym TEXT PRIMARY KEY,            -- '2026-01'
  cname TEXT,
  fetched_at TEXT                 -- 一覧を取得した日時（NULL = 未取得）
);

-- 開催（場・回・日ごと）
CREATE TABLE IF NOT EXISTS meetings (
  key TEXT PRIMARY KEY,           -- 年+場+回+日 '2026060101'
  date TEXT NOT NULL,
  venue_code TEXT NOT NULL,
  venue TEXT NOT NULL,
  srl_cname TEXT NOT NULL,        -- レース選択ページ
  ses_cname TEXT,                 -- 全レース結果ページ
  races_expected INTEGER,
  complete INTEGER NOT NULL DEFAULT 0,  -- 全レースの確定結果を取得済みなら 1
  fetched_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_meetings_date ON meetings(date);

-- 騎手・調教師（読み仮名検索用）
CREATE TABLE IF NOT EXISTS people (
  kind TEXT NOT NULL,             -- jockey / trainer
  id TEXT NOT NULL,               -- '05339'
  name TEXT,
  kana TEXT,                      -- 読み（カタカナ・空白なし）。'' = 取得したが無し、NULL = 未取得
  cname TEXT,                     -- プロフィールページ
  fetched_at TEXT,
  PRIMARY KEY (kind, id)
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- 出馬表（これから行われるレース）
CREATE TABLE IF NOT EXISTS cards (
  race_id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  venue_code TEXT NOT NULL,
  venue TEXT NOT NULL,
  race_no INTEGER NOT NULL,
  name TEXT,
  surface TEXT,
  distance INTEGER,
  class_text TEXT,
  grade TEXT,
  post_time TEXT,
  headcount INTEGER,
  fetched_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS card_entries (
  race_id TEXT NOT NULL REFERENCES cards(race_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,           -- 出馬表での並び順（枠順確定前は馬番が無いため）
  horse_no INTEGER,               -- 枠順確定前は NULL
  frame_no INTEGER,
  horse_id TEXT,
  horse_name TEXT,
  sex_age TEXT,
  weight_carried REAL,
  jockey_id TEXT,
  jockey_name TEXT,
  trainer_id TEXT,
  trainer_name TEXT,
  odds REAL,                      -- 取得時点の単勝オッズ
  status TEXT,                    -- '取消' / '除外' / NULL
  PRIMARY KEY (race_id, seq)
);

CREATE TABLE IF NOT EXISTS races (
  race_id TEXT PRIMARY KEY,       -- 202606010101 (年+場+回+日+R)
  date TEXT NOT NULL,
  venue_code TEXT NOT NULL,
  venue TEXT NOT NULL,
  race_no INTEGER NOT NULL,
  name TEXT,
  surface TEXT,                   -- 芝 / ダ / 障
  distance INTEGER,
  weather TEXT,
  track_condition TEXT,
  class_text TEXT,
  headcount INTEGER,
  fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_races_date ON races(date);

CREATE TABLE IF NOT EXISTS entries (
  race_id TEXT NOT NULL REFERENCES races(race_id) ON DELETE CASCADE,
  horse_no INTEGER NOT NULL,
  frame_no INTEGER,
  finish TEXT,                    -- '1', '2', '中止', '取消', '除外', '失格', '3(降)' など
  finish_num INTEGER,             -- 着順の数値（取消・除外・中止などは NULL）
  horse_id TEXT,
  horse_name TEXT,
  sex_age TEXT,
  weight_carried REAL,
  jockey_id TEXT,
  jockey_name TEXT,
  trainer_id TEXT,
  trainer_name TEXT,
  odds REAL,
  popularity INTEGER,
  horse_weight TEXT,
  PRIMARY KEY (race_id, horse_no)
);
CREATE INDEX IF NOT EXISTS idx_entries_jockey ON entries(jockey_id);
CREATE INDEX IF NOT EXISTS idx_entries_trainer ON entries(trainer_id);
CREATE INDEX IF NOT EXISTS idx_entries_horse ON entries(horse_id);

CREATE TABLE IF NOT EXISTS payouts (
  race_id TEXT NOT NULL REFERENCES races(race_id) ON DELETE CASCADE,
  bet_type TEXT NOT NULL,         -- 単勝 / 複勝 / 枠連 / 馬連 / ワイド / 馬単 / 三連複 / 三連単
  combination TEXT NOT NULL,      -- '7' / '7-15' など
  amount INTEGER NOT NULL,        -- 100円あたり払戻
  popularity INTEGER,
  PRIMARY KEY (race_id, bet_type, combination)
);
`);

// 列の追加（既存の DB を作り直さずに済むように）
const hasColumn = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
if (!hasColumn('races', 'grade')) db.exec('ALTER TABLE races ADD COLUMN grade TEXT'); // 'G1' 'G2' 'G3' 'JG1' 'L' など
if (!hasColumn('races', 'odds_cname')) db.exec('ALTER TABLE races ADD COLUMN odds_cname TEXT'); // 確定オッズページ
if (!hasColumn('races', 'odds_at')) db.exec('ALTER TABLE races ADD COLUMN odds_at TEXT'); // 全馬の確定オッズを取得した日時

// 外国人騎手・地方の騎手などコードの無い人は名前で識別する（'n:D.レーン'）。古いデータの空欄を埋める。
db.exec(`
UPDATE entries SET jockey_id = 'n:' || jockey_name WHERE jockey_id IS NULL AND jockey_name IS NOT NULL AND jockey_name != '';
UPDATE entries SET trainer_id = 'n:' || trainer_name WHERE trainer_id IS NULL AND trainer_name IS NOT NULL AND trainer_name != '';
`);

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
