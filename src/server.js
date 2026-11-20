import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSync, status, dbStats, todayJST } from './sync.js';
import { candidates, simulate } from './query.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT || 3939);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function range(p) {
  const from = p.get('from') || `${todayJST().slice(0, 4)}-01-01`;
  const to = p.get('to') || todayJST();
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) throw new Error('日付は YYYY-MM-DD 形式で指定してください');
  return { from, to };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.searchParams;
  try {
    if (url.pathname === '/api/status') return json(res, 200, { sync: status, db: dbStats(), today: todayJST() });
    if (url.pathname === '/api/sync' && req.method === 'POST') {
      const { from, to } = range(p);
      return json(res, 200, { sync: startSync(from, to) });
    }
    if (url.pathname === '/api/candidates') {
      const { from, to } = range(p);
      return json(res, 200, { candidates: candidates(p.get('kind') || 'jockey', p.get('q'), from, to) });
    }
    if (url.pathname === '/api/simulate') {
      const { from, to } = range(p);
      const filters = Object.fromEntries(['surface', 'venue', 'dist', 'pop', 'cond', 'cls'].map((k) => [k, p.get(k) || 'all']));
      return json(res, 200, simulate({
        kind: p.get('kind') || 'jockey', id: p.get('id'), from, to,
        bet: p.get('bet') || '単勝', stake: p.get('stake') || 100, ...filters,
      }));
    }
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' });

    // 静的ファイル
    const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^([/\\])+/, '');
    if (rel.includes('..')) return json(res, 400, { error: 'bad path' });
    const body = await readFile(join(PUBLIC, rel));
    res.writeHead(200, { 'Content-Type': MIME[extname(rel)] || 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    if (e.code === 'ENOENT') return json(res, 404, { error: 'not found' });
    json(res, 400, { error: String(e.message || e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`umaapp: http://localhost:${PORT}`);
});
