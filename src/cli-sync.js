// 使い方: npm run sync -- 2026-01-01 2026-11-19
// 開始日は省略時 環境変数 SYNC_FROM、それも無ければ今年の 1/1。終了日は省略時 今日。
import { db } from './db.js';
import { startSync, status, dbStats, todayJST } from './sync.js';

const from = process.argv[2] || process.env.SYNC_FROM || `${todayJST().slice(0, 4)}-01-01`;
const to = process.argv[3] || todayJST();
console.log(`同期: ${from} 〜 ${to}`);
startSync(from, to);
const timer = setInterval(() => {
  console.log(`[${status.phase}] ${status.daysDone}/${status.daysTotal}開催 新規${status.racesFetched}R ${status.waiting || status.message}`);
  if (!status.running) {
    clearInterval(timer);
    console.log(status.error ? `エラー: ${status.error}` : '完了', dbStats());
    db.close(); // WAL の内容を本体に書き戻してから終了
    process.exitCode = status.error ? 1 : 0;
  }
}, 10000);
