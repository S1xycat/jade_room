import assert from 'node:assert/strict';
import { createRooms } from './rooms.js';

const start = Date.parse('2026-11-21T02:00:00Z');
let time = start;
let stored;
const options = { now: () => time, random: () => 3, save: state => { stored = structuredClone(state); } };
let engine = createRooms(options);
let state = engine.snapshot();
assert.equal(state.rooms.dice.revealAt - time, 30_000);
assert.equal(state.rooms.baccarat.id, state.rooms.dice.id);
assert.equal(state.rooms.dice.latest, null);
assert.equal(Object.hasOwn(state, 'shoe'), false);
assert.equal(state.rooms.dice.phase, 'open');

const ticket = (round, stakes) => ({ roundId: round.id, version: round.version, stakes });
const diceRound = state.rooms.dice;
const original = ticket(diceRound, { big: 1_000, 'total:12': 2_500, tripleAny: 1_000 });
state = engine.setTicket('dice', original);
assert.equal(state.balance, 95_500);
assert.equal(engine.setTicket('dice', original).revision, state.revision);
assert.throws(() => engine.setTicket('dice', ticket(diceRound, { big: 2_500 })), { status: 409 });
assert.throws(() => engine.setTicket('baccarat', ticket(state.rooms.baccarat, { player: 96_000 })), { status: 409 });
assert.throws(() => engine.setTicket('baccarat', ticket(state.rooms.baccarat, { tie: 500 })), { status: 400 });

state = engine.setTicket('baccarat', ticket(state.rooms.baccarat, { banker: 1_000 }));
assert.equal(state.balance, 94_500);
state = engine.setTicket('baccarat', ticket(state.rooms.baccarat, {}));
assert.equal(state.balance, 95_500);
engine = createRooms({ ...options, initial: stored });
assert.equal(engine.snapshot().balance, 95_500);
assert.deepEqual(engine.snapshot().rooms.dice.stakes, original.stakes);

time += 27_000;
assert.equal(engine.tick(), true);
state = engine.snapshot();
assert.equal(state.rooms.dice.phase, 'locked');
assert.equal(state.rooms.dice.latest, null);
assert.throws(() => engine.setTicket('dice', ticket(state.rooms.dice, {})), { status: 409 });

time += 3_000;
assert.equal(engine.tick(), true);
state = engine.snapshot();
assert.equal(state.rooms.baccarat.id, 2);
assert.equal(state.rooms.dice.id, 2);
assert.equal(state.rooms.dice.latest.id, 1);
assert.deepEqual(state.rooms.dice.latest.outcome.dice, [4, 4, 4]);
assert.equal(state.rooms.baccarat.latest.outcome.player.length >= 2, true);
assert.equal(state.history.length, 1);
assert.equal(state.history[0].returned, 42_500);
assert.equal(state.balance, 138_000);
assert.equal(engine.tick(), false);
assert.throws(() => engine.setTicket('dice', original), { status: 409 });
time += 30_000;
assert.equal(engine.tick(), true);
assert.equal(engine.snapshot().history.length, 1);
assert.equal(engine.snapshot().rooms.dice.latest.id, 2);

time = Date.parse('2026-11-21T15:59:30Z');
const midnight = createRooms(options);
midnight.setTicket('dice', ticket(midnight.snapshot().rooms.dice, { tripleAny: 1_000 }));
time += 30_000;
midnight.tick();
assert.equal(midnight.snapshot().balance, 100_000);
assert.equal(midnight.snapshot().history[0].returned, 25_000);
assert.equal(midnight.snapshot().date, '2026-11-22');
assert.equal(midnight.snapshot().rooms.dice.id, 2);

const fast = createRooms({ ...options, intervalSeconds: 20 });
assert.equal(fast.snapshot().rooms.dice.revealAt - time, 20_000);
assert.throws(() => createRooms({ ...options, intervalSeconds: 25 }));
console.log('Passed: parallel rooms, 20/30s cadence, closing window, durable tickets, idempotency, cancellation, shared account, automatic settlement and midnight rollover.');
