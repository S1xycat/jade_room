import assert from 'node:assert/strict';
import { createRooms } from './rooms.js';
import { checkPassword, hashPassword, loginName, SESSION_SECONDS } from './accounts.js';
import { DENOMINATIONS } from '../dist/rules.js';

const start = Date.parse('2026-11-21T02:00:00Z');
let time = start;
let stored;
const options = { now: () => time, random: () => 3, save: state => { stored = structuredClone(state); } };
let engine = createRooms(options);
const credentials = await hashPassword('synthetic-test-passphrase');
assert.equal(await checkPassword('synthetic-test-passphrase', credentials), true);
assert.equal(await checkPassword('wrong-test-passphrase', credentials), false);
assert.equal(await checkPassword('synthetic-test-passphrase'), false);
assert.equal(loginName(' Ａlice ').key, 'alice');
assert.equal(loginName('鱼池玩家').name, '鱼池玩家');
assert.equal(loginName('<script>'), null);
assert.deepEqual(DENOMINATIONS, [10, 25, 50, 100, 200, 500]);

const alice = engine.createAccount('Alice', credentials);
const bob = engine.createAccount('Bob', credentials);
const admin = engine.createAccount('Admin', credentials, 'admin');
assert.throws(() => engine.createAccount('ALICE', credentials), { status: 409 });
assert.equal(engine.hasAdmin(), true);
const token = engine.signIn(alice.id);
assert.equal(engine.session(token).name, 'Alice');
assert.equal(Object.keys(stored.sessions).includes(token), false);
assert.equal(engine.session('a'.repeat(64)), undefined);
let state = engine.snapshot(alice.id);
assert.equal(state.rooms.dice.revealAt - time, 30_000);
assert.equal(state.rooms.baccarat.id, state.rooms.dice.id);
assert.equal(state.rooms.dice.latest, null);
assert.equal(Object.hasOwn(state, 'shoe'), false);
assert.equal(Object.hasOwn(state.user, 'credentials'), false);

const ticket = (round, stakes) => ({ roundId: round.id, version: round.version, stakes });
const play = (player, game, input) => engine.setTicket(player.id, game, input);
const diceRound = state.rooms.dice;
const original = ticket(diceRound, { big: 1_000, 'total:12': 2_500, tripleAny: 50_000 });
state = play(alice, 'dice', original);
assert.equal(state.balance, 46_500);
assert.equal(play(alice, 'dice', original).revision, state.revision);
assert.throws(() => play(alice, 'dice', ticket(diceRound, { big: 2_500 })), { status: 409 });
assert.throws(() => play(alice, 'baccarat', ticket(state.rooms.baccarat, { player: 96_000 })), { status: 409 });
assert.throws(() => play(alice, 'baccarat', ticket(state.rooms.baccarat, { tie: 500 })), { status: 400 });

const bobState = play(bob, 'dice', ticket(engine.snapshot(bob.id).rooms.dice, { small: 20_000 }));
assert.equal(bobState.balance, 80_000);
assert.deepEqual(bobState.rooms.dice.stakes, { small: 20_000 });
assert.equal(Object.hasOwn(bobState.rooms.dice, 'tickets'), false);
assert.deepEqual(engine.snapshot(alice.id).rooms.dice.stakes, original.stakes);
state = play(alice, 'baccarat', ticket(state.rooms.baccarat, { banker: 10_000 }));
assert.equal(state.balance, 36_500);
state = play(alice, 'baccarat', ticket(state.rooms.baccarat, {}));
assert.equal(state.balance, 46_500);

const grant = { playerId: bob.id, points: 750, requestId: '73105344-300c-4e63-aa77-5fd601777eb6' };
assert.throws(() => engine.adminState(alice.id), { status: 403 });
assert.throws(() => engine.grantPoints(alice.id, grant), { status: 403 });
assert.throws(() => engine.grantPoints(admin.id, { ...grant, points: -1 }), { status: 400 });
engine.grantPoints(admin.id, grant);
engine.grantPoints(admin.id, grant);
assert.throws(() => engine.grantPoints(admin.id, { ...grant, points: 900 }), { status: 409 });
assert.equal(engine.snapshot(bob.id).balance, 155_000);
assert.equal(engine.adminState(admin.id).grants[0].points, 750);

engine = createRooms({ ...options, initial: stored });
assert.equal(engine.session(token).name, 'Alice');
assert.equal(engine.snapshot(alice.id).balance, 46_500);
assert.deepEqual(engine.snapshot(alice.id).rooms.dice.stakes, original.stakes);
time += 27_000;
assert.equal(engine.tick(), true);
state = engine.snapshot(alice.id);
assert.equal(state.rooms.dice.phase, 'locked');
assert.throws(() => play(alice, 'dice', ticket(state.rooms.dice, {})), { status: 409 });
time += 3_000;
assert.equal(engine.tick(), true);
state = engine.snapshot(alice.id);
assert.equal(state.rooms.baccarat.id, 2);
assert.deepEqual(state.rooms.dice.latest.outcome.dice, [4, 4, 4]);
assert.equal(state.history.length, 1);
assert.equal(state.history[0].returned, 1_267_500);
assert.equal(state.balance, 1_314_000);
assert.equal(engine.snapshot(bob.id).history[0].staked, 20_000);
assert.equal(engine.snapshot(admin.id).history.length, 0);
assert.equal(engine.snapshot(admin.id).rooms.dice.latest.staked, 0);
assert.equal(engine.tick(), false);
engine.signOut(token);
assert.equal(engine.session(token), undefined);

time = Date.parse('2026-11-23T16:00:00Z');
engine.tick();
assert.equal(engine.snapshot(alice.id).date, '2026-11-24');
assert.equal(engine.snapshot(alice.id).balance, 1_614_000);
assert.equal(engine.snapshot(bob.id).balance, 455_000);
assert.equal(engine.tick(), false);
const expiring = engine.signIn(alice.id);
time += SESSION_SECONDS * 1000;
assert.equal(engine.session(expiring), undefined);

const legacyDate = '2026-11-21';
time = start;
const legacyRound = { id: 9, startsAt: time, closesAt: time + 27_000, revealAt: time + 30_000, version: 1 };
const legacy = {
  revision: 20, day: legacyDate, balance: 37_000, shoe: [], history: [],
  rooms: {
    baccarat: { latest: null, current: { ...legacyRound, stakes: {} } },
    dice: { latest: null, current: { ...legacyRound, stakes: { big: 1_000 } } },
  },
};
const upgraded = createRooms({ ...options, initial: legacy });
const firstAdmin = upgraded.createAccount('owner', credentials, 'admin');
assert.equal(firstAdmin.balance, 37_000);
assert.equal(firstAdmin.id, 'legacy');
assert.deepEqual(upgraded.snapshot(firstAdmin.id).rooms.dice.stakes, { big: 1_000 });

const fast = createRooms({ ...options, intervalSeconds: 20 });
const fastAccount = fast.createAccount('fastplayer', credentials);
assert.equal(fast.snapshot(fastAccount.id).rooms.dice.revealAt - time, 20_000);
assert.throws(() => createRooms({ ...options, intervalSeconds: 25 }));
console.log('Passed: account credentials, session lifecycle, private tickets, 500-point bets, grant authorization and retries, live settlement, offline daily accrual and legacy migration.');
