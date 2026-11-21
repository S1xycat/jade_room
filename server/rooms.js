import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { BETS, DAILY_POINTS, GAMES, dayKey, dealBaccarat, makeShoe, rollDice, settle } from '../dist/rules.js';
import { SESSION_SECONDS } from './accounts.js';

const lockMs = 3_000;
const games = Object.keys(GAMES);
const emptyTicket = { version: 0, stakes: {} };
const sum = stakes => Object.values(stakes).reduce((total, amount) => total + amount, 0);
const sameStakes = (first, second) => Object.keys(first).length === Object.keys(second).length &&
  Object.entries(first).every(([id, amount]) => second[id] === amount);
const lowercase = value => value.toLowerCase();
const tokenHash = token => createHash('sha256').update(token).digest('hex');
const dayNumber = date => Date.parse(date + 'T00:00:00Z') / 86_400_000;
const publicPlayer = player => ({ id: player.id, name: player.name, role: player.role, balance: player.balance });

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createRooms({ initial, save, intervalSeconds = 30, now = Date.now, random = randomInt }) {
  if (![20, 30].includes(intervalSeconds)) throw new Error('ROUND_INTERVAL_SECONDS must be 20 or 30');
  const duration = intervalSeconds * 1_000;
  const nextDeadline = time => (Math.floor(time / duration) + 1) * duration;
  const nextRound = (time, id) => {
    const deadline = nextDeadline(time);
    return { id, startsAt: deadline - duration, closesAt: deadline - lockMs, revealAt: deadline, tickets: {} };
  };
  const start = now();
  if (initial && ![undefined, 2].includes(initial.schema)) throw new Error('Unsupported state schema');
  let state = initial ?? {
    schema: 2, revision: 0, day: dayKey(start), shoe: [], players: {}, sessions: {}, grants: {},
    rooms: Object.fromEntries(games.map(game => [game, { current: nextRound(start, 1), latest: null }])),
  };
  let emittedPhases = '';

  const commit = next => {
    next.revision++;
    save(next);
    state = next;
  };

  if (initial && initial.schema === undefined) {
    const { balance, history, ...legacy } = structuredClone(initial);
    for (const game of games) {
      const { version, stakes, ...current } = legacy.rooms[game].current;
      legacy.rooms[game].current = { ...current, tickets: sum(stakes) ? { legacy: { version, stakes } } : {} };
    }
    commit({
      ...legacy, schema: 2, players: { legacy: { id: 'legacy', balance, history } }, sessions: {}, grants: {},
    });
  } else if (!initial) {
    save(state);
  }

  function advance(time = now()) {
    const date = dayKey(time);
    if (!games.some(game => state.rooms[game].current.revealAt <= time) && state.day >= date) return false;
    const next = structuredClone(state);
    for (const game of games) {
      const room = next.rooms[game];
      const current = room.current;
      if (time < current.revealAt) continue;
      if (game === 'baccarat' && next.shoe.length < 16) next.shoe = makeShoe(random);
      const outcome = game === 'baccarat' ? dealBaccarat(next.shoe) : rollDice(random);
      const result = { id: current.id, game, time: current.revealAt, outcome };
      room.latest = result;
      for (const [playerId, ticket] of Object.entries(current.tickets)) {
        if (!sum(ticket.stakes)) continue;
        const payout = settle(game, ticket.stakes, outcome);
        const player = next.players[playerId];
        player.balance += payout.returned;
        player.history = [{ ...result, ...payout }, ...player.history].slice(0, 100);
      }
      room.current = nextRound(time, current.id + 1);
    }
    if (next.day < date) {
      const days = dayNumber(date) - dayNumber(next.day);
      for (const player of Object.values(next.players)) player.balance += DAILY_POINTS * days;
      next.day = date;
    }
    commit(next);
    return true;
  }

  function snapshot(playerId, time = now()) {
    const player = state.players[playerId];
    const rooms = Object.fromEntries(games.map(game => {
      const { current, latest } = state.rooms[game];
      const { tickets, ...round } = current;
      const personal = latest && player.history.find(result => result.game === game && result.id === latest.id);
      return [game, {
        ...round, ...(tickets[playerId] ?? emptyTicket),
        latest: personal ?? (latest && { id: latest.id, game, time: latest.time, outcome: latest.outcome, staked: 0 }),
        phase: time < current.closesAt ? 'open' : 'locked',
      }];
    }));
    return {
      revision: state.revision, date: state.day, serverTime: time, intervalSeconds, balance: player.balance,
      user: publicPlayer(player), rooms, history: player.history,
    };
  }

  function tick() {
    const time = now();
    const changed = advance(time);
    const phases = games.map(game => time < state.rooms[game].current.closesAt).join(',');
    const phaseChanged = phases !== emittedPhases;
    emittedPhases = phases;
    return changed || phaseChanged;
  }

  function setTicket(playerId, game, input) {
    const time = now();
    advance(time);
    if (!Object.hasOwn(GAMES, game)) throw new RequestError(404, '找不到游戏。');
    const current = state.rooms[game].current;
    if (input?.roundId !== current.id || time >= current.closesAt) {
      throw new RequestError(409, '本局已封盘或结束，请核对下一局。');
    }
    const stakes = input.stakes;
    if (!stakes || typeof stakes !== 'object' || Array.isArray(stakes) ||
        Object.entries(stakes).some(([id, amount]) => !Object.hasOwn(BETS[game], id) ||
          !Number.isSafeInteger(amount) || amount < 1_000 || amount % 500 !== 0)) {
      throw new RequestError(400, '下注积分无效。');
    }
    const previous = current.tickets[playerId] ?? emptyTicket;
    if (sameStakes(previous.stakes, stakes)) return snapshot(playerId, time);
    if (input.version !== previous.version) throw new RequestError(409, '本局下注已在其他页面修改，请重新核对。');
    const balance = state.players[playerId].balance + sum(previous.stakes) - sum(stakes);
    if (!Number.isSafeInteger(balance) || balance < 0) throw new RequestError(409, '可用积分不足。');
    const next = structuredClone(state);
    next.players[playerId].balance = balance;
    next.rooms[game].current.tickets[playerId] = { version: previous.version + 1, stakes };
    commit(next);
    return snapshot(playerId, time);
  }

  function findAccount(key) {
    return Object.values(state.players).find(player => player.name && lowercase(player.name) === key);
  }

  function createAccount(name, credentials, role = 'player') {
    advance();
    if (findAccount(lowercase(name))) throw new RequestError(409, '该用户名已被使用。');
    const next = structuredClone(state);
    const legacy = role === 'admin' && next.players.legacy?.name === undefined ? next.players.legacy : null;
    const player = legacy ?? { id: randomUUID(), balance: DAILY_POINTS, history: [] };
    next.players[player.id] = Object.assign(player, { name, credentials, role });
    commit(next);
    return publicPlayer(player);
  }

  function session(token) {
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return undefined;
    const entry = state.sessions[tokenHash(token)];
    if (entry?.expires > now()) return publicPlayer(state.players[entry.playerId]);
  }

  function signIn(playerId, previousToken) {
    const next = structuredClone(state);
    const time = now();
    for (const [key, entry] of Object.entries(next.sessions)) {
      if (entry.expires <= time) delete next.sessions[key];
    }
    if (previousToken && session(previousToken)) delete next.sessions[tokenHash(previousToken)];
    const token = randomBytes(32).toString('hex');
    next.sessions[tokenHash(token)] = { playerId, expires: time + SESSION_SECONDS * 1000 };
    commit(next);
    return token;
  }

  function signOut(token) {
    if (!session(token)) return;
    const next = structuredClone(state);
    delete next.sessions[tokenHash(token)];
    commit(next);
  }

  function adminState(actorId) {
    if (state.players[actorId]?.role !== 'admin') throw new RequestError(403, '需要管理员权限。');
    return {
      players: Object.values(state.players).filter(player => player.name).map(publicPlayer)
        .sort((first, second) => first.name.localeCompare(second.name, 'zh-CN')),
      grants: Object.values(state.grants).slice(-25).reverse(),
    };
  }

  function grantPoints(actorId, input) {
    if (state.players[actorId]?.role !== 'admin') throw new RequestError(403, '需要管理员权限。');
    const playerId = input?.playerId;
    const units = input?.points * 100;
    const requestId = input?.requestId;
    if (typeof playerId !== 'string' || !Object.hasOwn(state.players, playerId) || !state.players[playerId].name ||
        typeof input?.points !== 'number' || !Number.isSafeInteger(input.points) || input.points < 1 ||
        !Number.isSafeInteger(units) || typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(requestId)) {
      throw new RequestError(400, '请选择已注册账户并输入正整数积分。');
    }
    const existing = state.grants[requestId];
    if (existing) {
      if (existing.actorId === actorId && existing.playerId === playerId && existing.points === input.points) return;
      throw new RequestError(409, '发放请求编号已被使用。');
    }
    advance();
    const next = structuredClone(state);
    const target = next.players[playerId];
    if (!Number.isSafeInteger(target.balance + units)) throw new RequestError(400, '发放金额过大。');
    target.balance += units;
    next.grants[requestId] = {
      actorId, actor: next.players[actorId].name, playerId, player: target.name, points: input.points, time: now(),
    };
    commit(next);
  }

  tick();
  return {
    snapshot, tick, setTicket, findAccount, createAccount, signIn, signOut, session, adminState, grantPoints,
    hasAdmin: () => Object.values(state.players).some(player => player.role === 'admin'),
  };
}
