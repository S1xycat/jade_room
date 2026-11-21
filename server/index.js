import { createServer } from 'node:http';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRooms, RequestError } from './rooms.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/rules.js', ['rules.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
].map(([url, [file, type]]) => [url, { body: readFileSync(new URL('../dist/' + file, import.meta.url)), type }]));

const stateFile = resolve(process.env.JADE_STATE_FILE ?? 'server-data/state.json');
mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
let initial;
try {
  initial = JSON.parse(readFileSync(stateFile, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const rooms = createRooms({
  initial,
  intervalSeconds: Number(process.env.ROUND_INTERVAL_SECONDS ?? 30),
  save(state) {
    const temporary = stateFile + '.tmp';
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flush: true });
    renameSync(temporary, stateFile);
  },
});

const clients = new Set();
function sendSnapshot(response, snapshot) {
  if (response.writableNeedDrain) {
    response.destroy();
    return;
  }
  response.write('data: ' + JSON.stringify(snapshot) + '\n\n');
}

function broadcast(snapshot = rooms.snapshot()) {
  for (const response of clients) sendSnapshot(response, snapshot);
}

function tick() {
  if (rooms.tick()) broadcast();
}

const timer = setInterval(() => {
  try { tick(); }
  catch (error) { console.error('Could not advance game rooms', error); }
}, 200);

const heartbeat = setInterval(() => {
  for (const response of clients) {
    if (response.writableNeedDrain) response.destroy();
    else response.write(': heartbeat\n\n');
  }
}, 15_000);

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '') ||
      request.headers['sec-fetch-site'] === 'cross-site') {
    throw new RequestError(415, '请求格式不受支持。');
  }
  // A same-host origin check also covers browsers without Fetch Metadata.
  const origin = request.headers.origin;
  if (origin) {
    let originHost;
    try { originHost = new URL(origin).host; }
    catch { throw new RequestError(403, '请求来源不受支持。'); }
    if (originHost !== request.headers.host) throw new RequestError(403, '请求来源不受支持。');
  }
  const chunks = [];
  let size = 0;
  // Drain oversized bodies, keeping only a bounded amount in memory.
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= 8_192) chunks.push(chunk);
  }
  if (size > 8_192) throw new RequestError(413, '请求内容过长。');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RequestError(400, '无法读取下注请求。'); }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    const asset = assets.get(url.pathname);
    if (asset && ['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(request.method === 'HEAD' ? undefined : asset.body);
      return;
    }
    if (url.pathname === '/api/live' && request.method === 'GET') {
      tick();
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      });
      clients.add(response);
      response.on('close', () => clients.delete(response));
      response.write('retry: 2000\n\n');
      sendSnapshot(response, rooms.snapshot());
      return;
    }
    if (url.pathname === '/api/state' && request.method === 'GET') {
      tick();
      json(response, 200, rooms.snapshot());
      return;
    }
    const ticket = /^\/api\/ticket\/(baccarat|dice)$/.exec(url.pathname);
    if (ticket && request.method === 'PUT') {
      const input = await readJson(request);
      tick();
      const snapshot = rooms.setTicket(ticket[1], input);
      broadcast(snapshot);
      json(response, 200, snapshot);
      return;
    }
    json(response, 404, { error: '页面不存在。' });
  } catch (error) {
    if (error instanceof RequestError) {
      json(response, error.status, { error: error.message, state: rooms.snapshot() });
    } else {
      console.error(error);
      if (response.headersSent) response.destroy();
      else json(response, 500, { error: '服务暂时不可用，请稍后重试。' });
    }
  }
});

server.on('close', () => {
  clearInterval(timer);
  clearInterval(heartbeat);
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    for (const response of clients) response.end();
    server.close();
    server.closeAllConnections();
  });
}

const port = Number(process.env.PORT ?? 3080);
server.listen(port, '127.0.0.1', () => console.log('Jade Room listening on 127.0.0.1:' + server.address().port));
