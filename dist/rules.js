export const DAILY_POINTS = 100_000;
export const DENOMINATIONS = [10, 25, 50];
export const GAMES = {
  baccarat: { name: '百家乐', action: '发牌', prompt: '选择庄、闲、和，或展开更多下注。' },
  dice: { name: '骰宝', action: '掷骰', prompt: '选择大、小，或展开点数和组合。' },
};

const sequence = (start, end) => Array.from({ length: end - start + 1 }, (_, index) => start + index);
const faces = sequence(1, 6);
const points = sequence(0, 9);
const totals = [50, 18, 14, 12, 8, 6, 6, 6, 6, 8, 12, 14, 18, 50];
const bet = (id, label, profit, tone = '') => ({ id, label, profit, tone });
const category = (label, rule, bets) => ({ label, rule, bets });
export const TABLES = {
  baccarat: [
    category('主注', '庄、闲最终点数相同为和局。押庄或闲遇和局，退回该注。', [
      bet('player', '闲', 1, 'blue'), bet('tie', '和', 8, 'green'), bet('banker', '庄', 0.95, 'red'),
    ]),
    category('对子', '看对应一方的前两张牌是否同牌阶。10、J、Q、K 虽同为 0 点，牌阶各不相同。', [
      bet('playerPair', '闲对', 11), bet('bankerPair', '庄对', 11),
    ]),
    category('闲最终点数', '含补牌，以个位数计点。和局时照常结算。', points.map(value =>
      bet('playerPoint:' + value, value + ' 点', value <= 5 ? 9 : 5))),
    category('庄最终点数', '含补牌，以个位数计点。和局时照常结算。', points.map(value =>
      bet('bankerPoint:' + value, value + ' 点', value <= 5 ? 9 : 5))),
    category('三张牌获胜', '龙 7 要求庄以三张牌 7 点获胜。熊猫 8 要求闲以三张牌 8 点获胜。', [
      bet('dragon', '龙 7', 40), bet('panda', '熊猫 8', 25),
    ]),
  ],
  dice: [
    category('主注', '小为 4–10 点，大为 11–17 点。三骰同点时，押大和押小都输。', [
      bet('small', '小', 1, 'blue'), bet('big', '大', 1, 'red'),
    ]),
    category('指定总点数', '三颗骰子的总和等于所选点数即命中，围骰也照常结算。', sequence(4, 17).map(value =>
      bet('total:' + value, value + ' 点', totals[value - 4]))),
    category('单骰点数', '所选骰面出现一、二、三次时，净赢分别为下注的 1、2、3 倍。', faces.map(value =>
      bet('single:' + value, value + ' 点', '1–3'))),
    category('指定双骰', '所选骰面至少出现两次。三颗全中也按同一倍数结算。', faces.map(value =>
      bet('double:' + value, '双 ' + value, 10))),
    category('两骰组合', '两个不同的所选骰面都要出现，顺序不限。', faces.flatMap(first =>
      faces.filter(second => second > first).map(second =>
        bet('combo:' + first + ':' + second, first + ' ＋ ' + second, 5)))),
    category('围骰', '指定围骰要求三颗都是所选点数，任意围骰只要求三颗点数相同。', [
      bet('tripleAny', '任意围骰', 24), ...faces.map(value => bet('triple:' + value, '三 ' + value, 150)),
    ]),
  ],
};

export const BETS = Object.fromEntries(Object.entries(TABLES).map(([game, categories]) => [
  game, Object.fromEntries(categories.flatMap(group => group.bets.map(item => [item.id, item]))),
]));

const randomBuffer = new Uint32Array(1);
export function randomInt(max) {
  const limit = 2 ** 32 - (2 ** 32 % max);
  do { globalThis.crypto.getRandomValues(randomBuffer); } while (randomBuffer[0] >= limit);
  return randomBuffer[0] % max;
}

export function makeShoe(random = randomInt) {
  const shoe = Array.from({ length: 416 }, (_, index) => index % 52);
  for (let index = shoe.length - 1; index > 0; index--) {
    const target = random(index + 1);
    [shoe[index], shoe[target]] = [shoe[target], shoe[index]];
  }
  return shoe;
}

export const cardRank = card => card % 13 + 1;
const cardValue = card => cardRank(card) >= 10 ? 0 : cardRank(card);
export const handPoints = hand => hand.reduce((sum, card) => sum + cardValue(card), 0) % 10;

export function bankerDraws(points, thirdCardValue) {
  if (thirdCardValue === null || points <= 2) return points <= 5;
  if (points === 3) return thirdCardValue !== 8;
  if (points === 4) return thirdCardValue >= 2 && thirdCardValue <= 7;
  if (points === 5) return thirdCardValue >= 4 && thirdCardValue <= 7;
  return points === 6 && (thirdCardValue === 6 || thirdCardValue === 7);
}

export function dealBaccarat(shoe) {
  const player = [shoe.pop()];
  const banker = [shoe.pop()];
  player.push(shoe.pop());
  banker.push(shoe.pop());
  const initialPlayer = handPoints(player);
  const initialBanker = handPoints(banker);
  if (Math.max(initialPlayer, initialBanker) < 8) {
    const third = initialPlayer <= 5 ? shoe.pop() : null;
    if (third !== null) player.push(third);
    if (bankerDraws(initialBanker, third === null ? null : cardValue(third))) banker.push(shoe.pop());
  }
  const playerPoint = handPoints(player);
  const bankerPoint = handPoints(banker);
  const winner = playerPoint === bankerPoint ? 'tie' : playerPoint > bankerPoint ? 'player' : 'banker';
  return { player, banker, playerPoint, bankerPoint, winner };
}

export function rollDice(random = randomInt) {
  const dice = Array.from({ length: 3 }, () => random(6) + 1);
  return {
    dice,
    total: dice.reduce((sum, value) => sum + value, 0),
    triple: dice.every(value => value === dice[0]),
  };
}

function returnFor(game, id, amount, outcome) {
  const [kind, value, other] = id.split(':');
  const point = Number(value);
  const profit = BETS[game][id].profit;
  let win;
  if (game === 'baccarat') {
    switch (kind) {
      case 'player': case 'banker':
        if (outcome.winner === 'tie') return { status: 'push', returned: amount };
        // Continue into the same winner comparison as a tie bet.
      case 'tie': win = outcome.winner === kind; break;
      case 'playerPair': win = cardRank(outcome.player[0]) === cardRank(outcome.player[1]); break;
      case 'bankerPair': win = cardRank(outcome.banker[0]) === cardRank(outcome.banker[1]); break;
      case 'playerPoint': case 'bankerPoint': win = outcome[kind] === point; break;
      case 'dragon': win = outcome.winner === 'banker' && outcome.bankerPoint === 7 && outcome.banker.length === 3; break;
      case 'panda': win = outcome.winner === 'player' && outcome.playerPoint === 8 && outcome.player.length === 3; break;
    }
  } else {
    const count = outcome.dice.filter(face => face === point).length;
    switch (kind) {
      case 'small': win = !outcome.triple && outcome.total <= 10; break;
      case 'big': win = !outcome.triple && outcome.total >= 11; break;
      case 'total': win = outcome.total === point; break;
      case 'single': return { status: count ? 'win' : 'loss', returned: count ? amount * (1 + count) : 0 };
      case 'double': win = count >= 2; break;
      case 'combo': win = count > 0 && outcome.dice.includes(Number(other)); break;
      case 'tripleAny': win = outcome.triple; break;
      case 'triple': win = count === 3; break;
    }
  }
  return { status: win ? 'win' : 'loss', returned: win ? amount + Math.round(amount * profit) : 0 };
}

export function settle(game, stakes, outcome) {
  const lines = Object.entries(stakes).map(([id, amount]) => ({
    id, amount, ...returnFor(game, id, amount, outcome),
  }));
  const staked = lines.reduce((sum, line) => sum + line.amount, 0);
  const returned = lines.reduce((sum, line) => sum + line.returned, 0);
  return { lines, staked, returned, net: returned - staked };
}

const dateFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });
export const dayKey = time => dateFormat.format(time);

export function onDay(state, time = Date.now()) {
  const day = dayKey(time);
  if (state?.day === day) return state;
  return { day, balance: DAILY_POINTS, history: state?.history ?? [], shoe: state?.shoe ?? [] };
}

export function playRound(state, game, stakes, { time = Date.now(), random = randomInt } = {}) {
  if (!Object.hasOwn(GAMES, game)) throw new Error('请选择有效的游戏。');
  const entries = Object.entries(stakes);
  if (entries.some(([id, amount]) => !Object.hasOwn(BETS[game], id) ||
      !Number.isSafeInteger(amount) || amount <= 0 || amount % 500 !== 0)) {
    throw new Error('下注积分无效，请清空后重试。');
  }
  const current = onDay(state, time);
  const total = entries.reduce((sum, [, amount]) => sum + amount, 0);
  if (total > current.balance) throw new Error('积分不足，请减少下注。');
  let shoe = current.shoe.slice();
  if (game === 'baccarat' && shoe.length < 16) shoe = makeShoe(random);
  const outcome = game === 'baccarat' ? dealBaccarat(shoe) : rollDice(random);
  const result = { id: (current.history[0]?.id ?? 0) + 1, game, time, outcome, ...settle(game, stakes, outcome) };
  return {
    ...current,
    balance: current.balance + result.net,
    history: [result, ...current.history].slice(0, 100),
    shoe,
  };
}
