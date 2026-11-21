import { createServer } from 'node:http';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRooms, RequestError } from './rooms.js';
import { checkPassword, hashPassword, loginName, rateLimiter, SESSION_SECONDS, validPassword } from './accounts.js';

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

if (process.env.JADE_ADMIN_USERNAME && !rooms.hasAdmin()) {
  const account = loginName(process.env.JADE_ADMIN_USERNAME);
  const password = process.env.JADE_ADMIN_PASSWORD_FILE
    ? readFileSync(process.env.JADE_ADMIN_PASSWORD_FILE, 'utf8').replace(/\r?\n$/, '')
    : process.env.JADE_ADMIN_PASSWORD;
  if (!account || !validPassword(password)) throw new Error('Invalid administrator bootstrap credentials');
  rooms.createAccount(account.name, await hashPassword(password), 'admin');
}

const clients = new Map();
const allowAuth = rateLimiter();
const sessionKey = 'jade_session';
function sessionToken(request) {
  const cookies = String(request.headers.cookie ?? '').split(';');
  return cookies.map(cookie => cookie.trim()).find(cookie => cookie.startsWith(sessionKey + '='))?.slice(sessionKey.length + 1);
}

function cookie(request, token, seconds) {
  const directLocal = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(request.headers.host ?? '') &&
    !request.headers['x-forwarded-proto'];
  return sessionKey + '=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + seconds + (directLocal ? '' : '; Secure');
}

function sendSnapshot(response, snapshot) {
  if (response.writableNeedDrain) {
    response.destroy();
    return;
  }
  response.write('data: ' + JSON.stringify(snapshot) + '\n\n');
}

function getClient(response, token) {
  const account = rooms.session(token);
  if (!account) response.end('event: signed-out\ndata: {}\n\n');
  return account;
}

function broadcast() {
  for (const [response, token] of clients) {
    const account = getClient(response, token);
    if (account) sendSnapshot(response, rooms.snapshot(account.id));
  }
}

function tick() {
  if (rooms.tick()) broadcast();
}

const timer = setInterval(() => {
  try { tick(); }
  catch (error) { console.error('Could not advance game rooms', error); }
}, 200);

const heartbeat = setInterval(() => {
  for (const [response, token] of clients) {
    if (!getClient(response, token)) continue;
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
  let account;
  try {
    const url = new URL(request.url, 'http://localhost');
    const asset = assets.get(url.pathname);
    if (asset && ['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.end(request.method === 'HEAD' ? undefined : asset.body);
      return;
    }
    const token = sessionToken(request);
    const authMode = url.pathname === '/api/auth/login' ? 'login' :
      url.pathname === '/api/auth/register' ? 'register' : null;
    if (authMode && request.method === 'POST') {
      const input = await readJson(request);
      const name = loginName(input?.username);
      if (!name || !validPassword(input?.password)) {
        throw new RequestError(400, '用户名需为 3–24 个字母、数字、下划线或连字符，密码至少 8 个字符。');
      }
      const forwardedIp = process.env.JADE_TRUST_PROXY === '1' ? request.headers['x-real-ip'] : undefined;
      const remoteIp = String(forwardedIp ?? request.socket.remoteAddress).slice(0, 128);
      if (!allowAuth(authMode === 'register' ? [['register:' + remoteIp, 15]] :
        [['login:' + remoteIp, 60], ['account:' + remoteIp + ':' + name.key, 12]])) {
        throw new RequestError(429, '操作过于频繁，请稍后重试。');
      }
      tick();
      if (authMode === 'register') {
        account = rooms.createAccount(name.name, await hashPassword(input.password));
      } else {
        const player = rooms.findAccount(name.key);
        if (!await checkPassword(input.password, player?.credentials)) {
          throw new RequestError(401, '用户名或密码错误。');
        }
        account = player;
      }
      const nextToken = rooms.signIn(account.id, token);
      broadcast();
      response.setHeader('Set-Cookie', cookie(request, nextToken, SESSION_SECONDS));
      json(response, 200, rooms.snapshot(account.id));
      return;
    }

    if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
      await readJson(request);
      rooms.signOut(token);
      broadcast();
      response.setHeader('Set-Cookie', cookie(request, '', 0));
      json(response, 200, { ok: true });
      return;
    }

    if (!url.pathname.startsWith('/api/')) throw new RequestError(404, '页面不存在。');
    account = rooms.session(token);
    if (!account) throw new RequestError(401, '请先登录。');

    if (url.pathname === '/api/live' && request.method === 'GET') {
      tick();
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      });
      clients.set(response, token);
      response.on('close', () => clients.delete(response));
      response.write('retry: 2000\n\n');
      sendSnapshot(response, rooms.snapshot(account.id));
      return;
    }
    if (url.pathname === '/api/state' && request.method === 'GET') {
      tick();
      json(response, 200, rooms.snapshot(account.id));
      return;
    }
    const ticket = /^\/api\/ticket\/(baccarat|dice)$/.exec(url.pathname);
    if (ticket && request.method === 'PUT') {
      const input = await readJson(request);
      if (!rooms.session(token)) throw new RequestError(401, '请先登录。');
      tick();
      const snapshot = rooms.setTicket(account.id, ticket[1], input);
      broadcast();
      json(response, 200, snapshot);
      return;
    }
    if (url.pathname === '/api/admin' && request.method === 'GET') {
      tick();
      json(response, 200, rooms.adminState(account.id));
      return;
    }
    if (url.pathname === '/api/admin/grants' && request.method === 'POST') {
      if (account.role !== 'admin') throw new RequestError(403, '需要管理员权限。');
      const input = await readJson(request);
      if (!rooms.session(token)) throw new RequestError(401, '请先登录。');
      tick();
      rooms.grantPoints(account.id, input);
      broadcast();
      json(response, 200, rooms.adminState(account.id));
      return;
    }
    json(response, 404, { error: '页面不存在。' });
  } catch (error) {
    if (error instanceof RequestError) {
      const snapshot = account && error.status === 409 ? rooms.snapshot(account.id) : undefined;
      json(response, error.status, { error: error.message, state: snapshot });
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
    for (const response of clients.keys()) response.end();
    server.close();
    server.closeAllConnections();
  });
}

const port = Number(process.env.PORT ?? 3080);
server.listen(port, '127.0.0.1', () => console.log('Jade Room listening on 127.0.0.1:' + server.address().port));
