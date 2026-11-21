import { BETS, DENOMINATIONS, GAMES, TABLES, cardRank, dayKey, onDay, playRound } from './rules.js';

const STORAGE_KEY = 'jade-table/v1';
const $ = id => document.getElementById(id);
const number = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const clock = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
const format = units => number.format(units / 100);
const signed = units => units > 0 ? '+' + format(units) : format(units);
const tone = units => units > 0 ? 'positive' : units < 0 ? 'negative' : '';
const statusNames = { win: '命中', loss: '未中', push: '退回' };
const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const suits = ['♠', '♥', '♦', '♣'];
const suitNames = ['黑桃', '红桃', '方片', '梅花'];
const pips = [[], [5], [1,9], [1,5,9], [1,3,7,9], [1,3,5,7,9], [1,3,4,6,7,9]];
const baccaratRules = 'A 算 1 点，2 至 9 按牌面计，10、J、Q、K 算 0 点。点数只取总和的个位。闲、庄各先发两张，任一方起手为 8 或 9 点即停牌，否则系统按标准百家乐规则自动补牌。押庄命中净赢 0.95 倍，和局则退回庄、闲主注。';
const diceRules = '每局独立掷三颗六面骰。多项下注可以同时命中，每项单独结算。';
const emptyMessage = description => '<p class="empty">' + description + '</p>';
const winnerName = winner => BETS.baccarat[winner].label;

let game = 'baccarat';
let denomination = 10;
let pending = false;
let notice = '';
let drafts = { baccarat: {}, dice: {} };
let state = onDay(null);

function readState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  return onDay(raw ? JSON.parse(raw) : null);
}

function syncState() {
  const previousDay = state.day;
  try {
    state = readState();
  } catch {
    notice = '无法读取浏览器存储，请检查站点存储权限。';
  }
  if (previousDay !== state.day) {
    drafts = { baccarat: {}, dice: {} };
    notice = '新一天已开始，积分已重置。';
  }
}

const selected = () => drafts[game];
const staked = () => Object.values(selected()).reduce((sum, value) => sum + value, 0);
const lastRound = () => state.history.find(item => item.game === game);
const betName = (currentGame, id) => {
  const item = BETS[currentGame][id];
  if (id.startsWith('playerPoint:')) return '闲最终 ' + item.label;
  if (id.startsWith('bankerPoint:')) return '庄最终 ' + item.label;
  if (id.startsWith('total:')) return '总点数 ' + item.label;
  if (id.startsWith('single:')) return '单骰 ' + item.label;
  if (id.startsWith('combo:')) return '组合 ' + item.label;
  return item.label;
};
const profitText = item => item.profit + ' 倍';

function cardMarkup(card) {
  if (card === undefined) return '<span class="card card-back" aria-hidden="true"><span>♠</span></span>';
  const suit = Math.floor(card / 13);
  const rank = ranks[cardRank(card) - 1];
  return '<span class="card ' + ([1, 2].includes(suit) ? 'card-red' : '') + '" aria-label="' + suitNames[suit] + rank +
    '"><b>' + rank + '</b><span>' + suits[suit] + '</span></span>';
}

function handMarkup(label, hand, point, side) {
  const cards = (hand ?? [undefined, undefined]).map(cardMarkup).join('');
  const points = point === undefined ? '—' : point + ' 点';
  return '<div class="hand ' + side + '"><div class="cards">' + cards + '</div><div class="hand-label"><span>' +
    label + '</span><strong>' + points + '</strong></div></div>';
}

function dieMarkup(value) {
  if (!value) return '<span class="die die-back" aria-hidden="true">?</span>';
  return '<span class="die" aria-label="' + value + ' 点">' + pips[value].map(position =>
    '<i style="grid-area:' + Math.ceil(position / 3) + '/' + ((position - 1) % 3 + 1) + '"></i>').join('') + '</span>';
}

function outcomeText(round) {
  if (round.game === 'baccarat') {
    const { winner, playerPoint, bankerPoint } = round.outcome;
    return (winner === 'tie' ? '和局' : winnerName(winner) + '赢') + ' · 闲 ' + playerPoint + ' 点，庄 ' + bankerPoint + ' 点';
  }
  const { dice, total, triple } = round.outcome;
  return dice.join(' · ') + '，合计 ' + total + ' 点' + (triple ? ' · 围骰' : total <= 10 ? ' · 小' : ' · 大');
}

function renderStage(round) {
  const outcome = round?.outcome;
  $('table').dataset.game = game;
  $('game-name').textContent = GAMES[game].name;
  $('round-note').textContent = round ? (round.staked ? '第 ' + round.id + ' 局' : '练习局') : '等待' + GAMES[game].action;
  $('table-note').textContent = round ? outcomeText(round) : GAMES[game].prompt;
  if (game === 'baccarat') {
    $('stage').innerHTML = handMarkup('闲', outcome?.player, outcome?.playerPoint, 'player-hand') +
      '<span class="versus" aria-hidden="true">♦</span>' +
      handMarkup('庄', outcome?.banker, outcome?.bankerPoint, 'banker-hand');
  } else {
    $('stage').innerHTML = '<div class="dice-tray">' + (outcome?.dice ?? [0, 0, 0]).map(dieMarkup).join('') + '</div>';
  }
}

function betMarkup(item) {
  const current = selected()[item.id] ?? 0;
  return '<button type="button" class="bet ' + item.tone + '" data-bet="' + item.id + '" aria-label="' +
    betName(game, item.id) + '，净赢 ' + profitText(item) + (current ? '，已下注 ' + format(current) + ' 积分' : '') +
    '" aria-pressed="' + Boolean(current) + '"><span>' + item.label + ' <small>（' + profitText(item) +
    '）</small></span>' + (current ? '<b>' + format(current) + '</b>' : '') + '</button>';
}

function renderBoard() {
  const [main, ...other] = TABLES[game];
  $('main-bets').innerHTML = '<div class="bet-grid main-grid">' + main.bets.map(betMarkup).join('') + '</div>';
  $('advanced-count').textContent = other.reduce((sum, item) => sum + item.bets.length, 0) + ' 项';
  $('side-bets').innerHTML = other.map(group => '<section class="bet-group"><h3>' + group.label + '</h3><p>' +
    group.rule + '</p><div class="bet-grid">' + group.bets.map(betMarkup).join('') + '</div></section>').join('');
}

function renderSlip() {
  $('balance').textContent = format(state.balance);
  $('chips').innerHTML = DENOMINATIONS.map(value => '<button type="button" class="chip" data-chip="' + value +
    '" aria-pressed="' + (denomination === value) + '" aria-label="' + value + ' 积分档位"><span>' +
    value + '</span></button>').join('');
  const total = staked();
  $('slip-lines').innerHTML = total ? Object.entries(selected()).map(([id, value]) =>
    '<div class="slip-line"><span>' + betName(game, id) + '</span><strong>' + format(value) +
    '</strong><button type="button" data-remove="' + id + '" aria-label="移除' + betName(game, id) +
    '">×</button></div>').join('') : emptyMessage('选择积分档位，再点选下注项。');
  $('stake-total').textContent = format(total) + ' 积分';
  $('clear').disabled = !total || pending;
  $('play').disabled = !total || pending || total > state.balance;
  $('play').textContent = '确认下注并' + GAMES[game].action;
  $('practice').disabled = pending;
  $('status').textContent = notice || (state.balance < 1000 ? '余额低于 10 积分，仍可免费练习。' : '');
}

function renderSettlement(round) {
  $('last-round').textContent = round?.staked ? '第 ' + round.id + ' 局' : round ? '练习局' : '';
  $('settlement').innerHTML = !round ? emptyMessage('本桌还没有结算。') : !round.staked
    ? emptyMessage('练习局不扣除或返还积分。')
    : '<div class="settlement-total"><span>净变动</span><strong class="' + tone(round.net) + '">' +
      signed(round.net) + '</strong></div>' + round.lines.map(line =>
      '<div class="settlement-line"><span>' + betName(game, line.id) + '</span><span class="' +
      tone(line.returned - line.amount) + '">' + statusNames[line.status] + ' · 返还 ' + format(line.returned) +
      ' · 净变动 ' + signed(line.returned - line.amount) + '</span></div>').join('') +
      '<div class="settlement-foot">下注 ' + format(round.staked) + ' · 总返还 ' + format(round.returned) + '</div>';
}

function renderRules() {
  $('rules-title').textContent = GAMES[game].name + '规则';
  $('rules-content').innerHTML = '<p>' + (game === 'baccarat' ? baccaratRules : diceRules) + '</p>' +
    '<p>净赢倍数只计算赢得的积分。命中时总返还为本金加净赢，退回时仅返还本金。下列倍数适用于本游戏。</p>' +
    TABLES[game].map(group => '<section><h3>' + group.label + '</h3><p>' + group.rule +
    '</p><p class="odds-list">' + group.bets.map(item => item.label + ' ' + profitText(item)).join('　·　') +
    '</p></section>').join('');
}

function renderHistory() {
  $('history-content').innerHTML = state.history.length ? state.history.map(round => {
    const lines = round.lines.map(line => '<div class="settlement-line"><span>' + betName(round.game, line.id) +
      '</span><span>' + statusNames[line.status] + ' · 下注 ' + format(line.amount) + ' · 返还 ' +
      format(line.returned) + ' · 净变动 ' + signed(line.returned - line.amount) + '</span></div>').join('');
    return '<details class="history-item"><summary><span><strong>' + GAMES[round.game].name + '</strong> <small>' +
      clock.format(round.time) + '</small></span><strong class="' + tone(round.net) + '">' +
      (round.staked ? signed(round.net) + ' 积分' : '练习') + '</strong></summary><div><p>' +
      outcomeText(round) + '</p>' + lines + '</div></details>';
  }).join('') : emptyMessage('完成第一局后，战绩会显示在这里。');
}

function render() {
  const round = lastRound();
  document.querySelectorAll('[data-game]').forEach(button => {
    if (button.matches('button')) button.setAttribute('aria-pressed', button.dataset.game === game);
  });
  renderStage(round);
  renderBoard();
  renderSlip();
  renderSettlement(round);
  if ($('history-dialog').open) renderHistory();
}

function restoreButton(attribute, value) {
  [...document.querySelectorAll('button[' + attribute + ']')].find(button =>
    button.getAttribute(attribute) === value)?.focus();
}

function updateBets(event) {
  const button = event.target.closest('[data-bet]');
  if (!button || pending) return;
  notice = '';
  syncState();
  if (staked() + denomination * 100 > state.balance) {
    notice = '积分不足，请减少下注或选择免费练习。';
  } else {
    const id = button.dataset.bet;
    selected()[id] = (selected()[id] ?? 0) + denomination * 100;
  }
  renderBoard();
  renderSlip();
  restoreButton('data-bet', button.dataset.bet);
}

async function finishRound(practice) {
  if (pending || (!practice && !staked())) return;
  const activeGame = game;
  const draft = practice ? {} : { ...selected() };
  const betDay = state.day;
  pending = true;
  notice = '';
  renderSlip();
  const commit = () => {
    const current = readState();
    if (!practice && current.day !== betDay) throw new Error('新一天已开始，请重新选择下注。');
    const next = playRound(current, activeGame, draft);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    if (current.day !== state.day) drafts = { baccarat: {}, dice: {} };
    state = next;
    if (!practice) drafts[activeGame] = {};
  };
  try {
    if (navigator.locks) await navigator.locks.request(STORAGE_KEY, commit);
    else commit();
    notice = practice ? '练习局已完成。' : '本局已结算，余额已更新。';
  } catch (error) {
    syncState();
    notice = error instanceof DOMException ? '无法保存战绩，请检查站点存储权限。' : error.message;
  } finally {
    pending = false;
    render();
  }
}

document.querySelector('.game-tabs').addEventListener('click', event => {
  const button = event.target.closest('[data-game]');
  if (!button || pending || game === button.dataset.game) return;
  game = button.dataset.game;
  $('advanced').open = false;
  notice = '';
  syncState();
  render();
});
$('main-bets').addEventListener('click', updateBets);
$('side-bets').addEventListener('click', updateBets);
$('chips').addEventListener('click', event => {
  const button = event.target.closest('[data-chip]');
  if (!button || pending) return;
  denomination = Number(button.dataset.chip);
  notice = '';
  renderSlip();
  restoreButton('data-chip', button.dataset.chip);
});
$('slip-lines').addEventListener('click', event => {
  const button = event.target.closest('[data-remove]');
  if (!button || pending) return;
  delete selected()[button.dataset.remove];
  notice = '';
  renderBoard();
  renderSlip();
  restoreButton('data-bet', button.dataset.remove);
});
$('clear').addEventListener('click', () => {
  drafts[game] = {};
  notice = '';
  renderBoard();
  renderSlip();
});
$('play').addEventListener('click', () => finishRound(false));
$('practice').addEventListener('click', () => finishRound(true));
$('rules-open').addEventListener('click', () => {
  renderRules();
  $('rules-dialog').showModal();
});
$('history-open').addEventListener('click', () => {
  renderHistory();
  $('history-dialog').showModal();
});
window.addEventListener('storage', event => {
  if (event.key === STORAGE_KEY || event.key === null) {
    syncState();
    render();
  }
});
window.addEventListener('focus', () => {
  const previous = state;
  syncState();
  if (previous.day !== state.day || previous.history[0]?.id !== state.history[0]?.id) render();
});
setInterval(() => {
  if (state.day !== dayKey(Date.now())) {
    syncState();
    render();
  }
}, 1000);
syncState();
render();
