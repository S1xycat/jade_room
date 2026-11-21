import assert from 'node:assert/strict';
import { BETS, DAILY_POINTS, bankerDraws, cardRank, dayKey, dealBaccarat, handPoints, makeShoe, onDay, playRound, rollDice, settle } from './dist/rules.js';

const before = Date.parse('2026-11-21T15:59:59.999Z');
const midnight = before + 1;
assert.equal(dayKey(before), '2026-11-21');
assert.equal(dayKey(midnight), '2026-11-22');
const initial = onDay(null, before);
assert.equal(initial.balance, DAILY_POINTS);
const first = playRound(initial, 'dice', { small: 1000, big: 2500 }, { time: before, random: () => 3 });
assert.equal(first.balance, DAILY_POINTS - 3500);
assert.equal(first.history[0].outcome.total, 12);
assert.equal(first.history[0].outcome.triple, true);
assert.equal(initial.history.length, 0);
assert.strictEqual(onDay(first, before), first);
assert.equal(onDay(first, midnight).balance, DAILY_POINTS);
assert.deepEqual(onDay(first, midnight).history, first.history);
const practice = playRound(first, 'baccarat', {}, { time: before, random: () => 0 });
assert.equal(practice.balance, first.balance);
assert.equal(practice.history.length, 2);
assert.equal(practice.history[0].staked, 0);
assert.equal(practice.shoe.length >= 410 && practice.shoe.length <= 412, true);
assert.throws(() => playRound(first, 'dice', { invalid: 1000 }, { time: before }));
assert.throws(() => playRound(first, 'dice', { big: 1003 }, { time: before }));
assert.throws(() => playRound(first, 'dice', { big: 100000 }, { time: before }));
const shoe = makeShoe(() => 0);
for (let id = 0; id < 52; id++) assert.equal(shoe.filter(card => card === id).length, 8);
assert.equal(cardRank(12), 13);
assert.equal(handPoints([9,10,11,12]), 0);
const expectedDraws = ['0123456789','0123456789','0123456789','012345679','234567','4567','67','','',''];
for (let point = 0; point <= 9; point++) {
  assert.equal(bankerDraws(point, null), point <= 5);
  for (let third = 0; third <= 9; third++) assert.equal(bankerDraws(point, third), expectedDraws[point].includes(third));
}
const deal = (...ordered) => dealBaccarat(ordered.reverse());
const natural = deal(3, 1, 4, 0, 8, 10);
assert.deepEqual(natural, { player: [3, 4], banker: [1, 0], playerPoint: 9, bankerPoint: 3, winner: 'player' });
const panda = deal(1, 0, 1, 0, 3, 2);
assert.equal(panda.playerPoint, 8);
assert.equal(panda.player.length, 3);
assert.equal(settle('baccarat', { panda: 1000, playerPair: 1000, 'playerPoint:8': 1000 }, panda).returned, 44000);
const dragon = deal(0, 1, 1, 0, 1, 3);
assert.equal(dragon.bankerPoint, 7);
assert.equal(settle('baccarat', { dragon: 1000, banker: 1000 }, dragon).returned, 42950);
const tie = deal(9, 10, 10, 9, 12, 12);
const returns = settle('baccarat', { banker: 1000, player: 1000, tie: 1000, playerPair: 1000, 'bankerPoint:0': 1000 }, tie);
assert.deepEqual(returns.lines.map(line => [line.status, line.returned]), [
  ['push', 1000], ['push', 1000], ['win', 9000], ['loss', 0], ['win', 10000],
]);

const winningFrequencies = Object.fromEntries(Object.keys(BETS.dice).map(id => [id, 0]));
for (let first = 1; first <= 6; first++) {
  for (let second = 1; second <= 6; second++) {
    for (let third = 1; third <= 6; third++) {
      const values = [first, second, third];
      const outcome = rollDice(() => values.shift() - 1);
      const stakes = Object.fromEntries(Object.keys(BETS.dice).map(id => [id, 1000]));
      const lines = settle('dice', stakes, outcome).lines;
      for (const line of lines) if (line.status === 'win') winningFrequencies[line.id]++;
      const multiplicity = [first, second, third].filter(value => value === 4).length;
      assert.equal(lines.find(line => line.id === 'single:4').returned, multiplicity ? (1 + multiplicity) * 1000 : 0);
      assert.equal(lines.find(line => line.id === 'double:4').status === 'win', multiplicity >= 2);
    }
  }
}
assert.equal(winningFrequencies.small, 105);
assert.equal(winningFrequencies.big, 105);
assert.equal(winningFrequencies.tripleAny, 6);
assert.equal(winningFrequencies['triple:4'], 1);
assert.equal(winningFrequencies['double:4'], 16);
assert.equal(winningFrequencies['combo:2:5'], 30);
assert.equal(winningFrequencies['total:4'], 3);
assert.equal(winningFrequencies['total:12'], 25);
const complex = settle('dice', { big: 1000, 'total:12': 1000, tripleAny: 1000 }, { dice: [4,4,4], total: 12, triple: true });
assert.deepEqual(complex.lines.map(line => line.status), ['loss','win','win']);
assert.equal(complex.net, 29000);
console.log('Passed: daily rollover, shared balance, insufficient funds, practice, baccarat shoe and draw matrix, baccarat side bets, all 216 dice outcomes, multi-bet settlement.');
