// 静的ファイル配信 + オンライン試合用 WebSocket サーバー。
//   npm start          → http://localhost:8000/   (PORT 環境変数で変更可)
//   ?room=名前 を付けると別のルームで試合できる (既定は main)
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Room } from './room.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8000;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

// 配信するのは画面 (index.html) とブラウザ用のモジュール (src/) だけ
async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.resolve(ROOT, '.' + rel);
  const allowed = file === path.join(ROOT, 'index.html') || file.startsWith(path.join(ROOT, 'src') + path.sep);
  if (!allowed) {
    res.writeHead(404).end('Not found');
    return;
  }
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

const server = http.createServer((req, res) => {
  serveStatic(req, res).catch(() => res.writeHead(500).end());
});

const rooms = new Map();        // ルーム名 → { room, sockets: Map<playerId, ws> }
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

function broadcast(entry) {
  for (const [pid, ws] of entry.sockets) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'state', state: entry.room.snapshot(pid) }));
  }
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const roomName = (url.searchParams.get('room') || 'main').slice(0, 40);
  if (!rooms.has(roomName)) rooms.set(roomName, { room: new Room(roomName), sockets: new Map() });
  const entry = rooms.get(roomName);
  let playerId = null;

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const reply = (r) => { if (!r.ok && !r.silent) ws.send(JSON.stringify({ type: 'error', error: r.error })); };
    if (msg.type === 'hello') {
      // id はタブごと (sessionStorage) に持つので、リロードしても同じ選手として試合に戻れる
      const id = String(msg.id ?? '').slice(0, 64);
      if (!id) return;
      const old = entry.sockets.get(id);
      if (old && old !== ws) old.close(4000, 'replaced');
      playerId = id;
      entry.sockets.set(id, ws);
      entry.room.join(id, msg.name);
    } else if (!playerId) {
      return;
    } else if (msg.type === 'rename') {
      entry.room.rename(playerId, msg.name);
    } else if (msg.type === 'start') {
      reply(entry.room.start(playerId, msg));
    } else if (msg.type === 'arrow') {
      reply(entry.room.recordArrow(playerId, msg));
    } else if (msg.type === 'evacuate') {
      reply(entry.room.evacuate(playerId));
    } else if (msg.type === 'debugStorm' && process.env.ARCHERY_DEBUG) {
      // 動作確認用: 試合中の天候をすぐ雷雨にする (ARCHERY_DEBUG=1 で起動したときだけ)
      entry.room.match?.weather.startStorm(Date.now());
    } else {
      return;
    }
    broadcast(entry);
  });

  ws.on('close', () => {
    if (!playerId || entry.sockets.get(playerId) !== ws) return;
    entry.sockets.delete(playerId);
    entry.room.leave(playerId);
    broadcast(entry);
    if (entry.sockets.size === 0) rooms.delete(roomName);
  });
});

// 天候の進行・避難期限の判定 (0.5 秒ごと)。変化があったルームだけ全員に送る
setInterval(() => {
  const now = Date.now();
  for (const entry of rooms.values()) if (entry.room.tick(now)) broadcast(entry);
}, 500).unref();

// 応答のない接続 (スリープ・回線断) を 30 秒ごとに検出して切る
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) ws.terminate();
    else {
      ws.isAlive = false;
      ws.ping();
    }
  }
}, 30000).unref();

server.listen(PORT, () => {
  console.log(`archery simulator: http://localhost:${PORT}/`);
});
