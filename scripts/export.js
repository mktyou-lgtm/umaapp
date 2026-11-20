// SQLite のデータを静的サイト（GitHub Pages）用に書き出す。
// 使い方: npm run export  → site/ に public/ の画面と data/data.json を出力
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDataset } from '../src/dataset.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'site');

rmSync(OUT, { recursive: true, force: true });
cpSync(join(ROOT, 'public'), OUT, { recursive: true });
mkdirSync(join(OUT, 'data'), { recursive: true });

const data = buildDataset();
const json = JSON.stringify(data);
writeFileSync(join(OUT, 'data', 'data.json'), json);
writeFileSync(join(OUT, '.nojekyll'), '');
console.log(`site/ に書き出しました: ${data.races.length} レース, ${data.entries.length} 出走, 出馬表 ${data.cards.races.length} レース, data.json ${(json.length / 1024 / 1024).toFixed(2)} MB`);
