import { BETS, DAILY_POINTS, GAMES, dayKey, dealBaccarat, makeShoe, randomInt, rollDice, settle } from '../dist/rules.js';

const lockMs = 3_000;
const games = Object.keys(GAMES);
const sum = stakes => Object.values(stakes).reduce((total, amount) => total + amount, 0);
const sameStakes = (first, second) => Object.keys(first).length === Object.keys(second).length &&
  Object.entries(first).every(([id, amount]) => second[id] === amount);

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
    return { id, startsAt: deadline - duration, closesAt: deadline - lockMs, revealAt: deadline, version: 0, stakes: {} };
  };
  const start = now();
  let state = initial ?? {
    revision: 0, day: dayKey(start), balance: DAILY_POINTS, shoe: [], history: [],
    rooms: Object.fromEntries(games.map(game => [game, { current: nextRound(start, 1), latest: null }])),
  };
  let emittedPhases = '';

  const commit = next => {
    next.revision++;
    save(next);
    state = next;
  };

  function advance(time = now()) {
    const date = dayKey(time);
    if (!games.some(game => state.rooms[game].current.revealAt <= time) && state.day === date) return false;
    const next = structuredClone(state);
    for (const game of games) {
      const room = next.rooms[game];
      const current = room.current;
      if (time < current.revealAt) continue;
      if (game === 'baccarat' && next.shoe.length < 16) next.shoe = makeShoe(random);
      const outcome = game === 'baccarat' ? dealBaccarat(next.shoe) : rollDice(random);
      const result = {
        id: current.id, game, time: current.revealAt, outcome, ...settle(game, current.stakes, outcome),
      };
      room.latest = result;
      next.balance += result.returned;
      if (result.staked) next.history.unshift(result);
      room.current = nextRound(time, current.id + 1);
    }
    if (next.day !== date) {
      next.day = date;
      next.balance = DAILY_POINTS;
    }
    next.history = next.history.slice(0, 100);
    commit(next);
    return true;
  }

  function snapshot(time = now()) {
    const rooms = Object.fromEntries(games.map(game => {
      const { current, latest } = state.rooms[game];
      return [game, {
        ...current, latest,
        phase: time < current.closesAt ? 'open' : 'locked',
      }];
    }));
    return { revision: state.revision, date: state.day, serverTime: time, intervalSeconds, balance: state.balance, rooms, history: state.history };
  }

  function tick() {
    const time = now();
    const changed = advance(time);
    const phases = games.map(game => time < state.rooms[game].current.closesAt).join(',');
    const phaseChanged = phases !== emittedPhases;
    emittedPhases = phases;
    return changed || phaseChanged;
  }

  function setTicket(game, input) {
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
    if (sameStakes(current.stakes, stakes)) return snapshot(time);
    if (input.version !== current.version) throw new RequestError(409, '本局下注已在其他页面修改，请重新核对。');
    const balance = state.balance + sum(current.stakes) - sum(stakes);
    if (!Number.isSafeInteger(balance) || balance < 0) throw new RequestError(409, '可用积分不足。');
    const next = structuredClone(state);
    next.balance = balance;
    next.rooms[game].current = { ...current, version: current.version + 1, stakes };
    commit(next);
    return snapshot(time);
  }

  if (!initial) save(state);
  tick();
  return { snapshot, tick, setTicket };
}
