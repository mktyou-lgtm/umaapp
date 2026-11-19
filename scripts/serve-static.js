// site/ を GitHub Pages と同じように静的配信して確認するための簡易サーバー（API なし）
// 使い方: npm run preview → http://localhost:4000
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..', 'site');
const PORT = Number(process.env.PORT || 4000);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8' };

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const rel = normalize(path.endsWith('/') ? path + 'index.html' : path).replace(/^([/\\])+/, '');
  try {
    if (rel.includes('..')) throw Object.assign(new Error(), { code: 'ENOENT' });
    const body = await readFile(join(SITE, rel));
    res.writeHead(200, { 'Content-Type': MIME[extname(rel)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>404</h1>');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`site preview: http://localhost:${PORT}`));
