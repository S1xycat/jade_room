import { BETS, DENOMINATIONS, GAMES, TABLES, cardRank } from './rules.js';
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
let state = null;
let connected = false;
let stream;
let mode = 'login';
let authRevision = 0;
let loginBusy = false;
let pendingGrant;
let receivedAt = 0;
let timerView = '';
const drafts = {};
const totalStake = stakes => Object.values(stakes).reduce((sum, value) => sum + value, 0);
const sameStakes = (first, second) => Object.keys(first).length === Object.keys(second).length &&
  Object.entries(first).every(([id, amount]) => second[id] === amount);
const room = () => state?.rooms[game];
const selected = () => drafts[game]?.stakes ?? {};
const staked = () => totalStake(selected());
const confirmed = () => totalStake(room()?.stakes ?? {});
const serverTime = () => state ? state.serverTime + (performance.now() - receivedAt) : 0;
const canBet = () => connected && room()?.phase === 'open' && serverTime() < room().closesAt;
const canUpdate = () => canBet() && !pending;
const reveal = () => Boolean(room()?.latest && room().latest.time === room().startsAt && serverTime() < room().startsAt + 5_000);
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
  $('table-note').textContent = round ? '第 ' + round.id + ' 局 · ' + outcomeText(round) :
    canBet() ? '选好下注后请确认，封盘后由系统自动开奖。' : '结果将在倒计时结束时公布。';
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
    '" aria-pressed="' + Boolean(current) + '"' + (canUpdate() ? '' : ' disabled') + '><span>' + item.label + ' <small>（' + profitText(item) +
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
  $('balance').textContent = state ? format(state.balance) : '—';
  $('session-name').textContent = state?.user.name ?? '';
  $('admin-open').hidden = state?.user.role !== 'admin';
  $('chips').innerHTML = DENOMINATIONS.map(value => '<button type="button" class="chip" data-chip="' + value +
    '" aria-pressed="' + (denomination === value) + '" aria-label="' + value + ' 积分档位"><span>' +
    value + '</span></button>').join('');
  const total = staked();
  $('slip-lines').innerHTML = total ? Object.entries(selected()).map(([id, value]) =>
    '<div class="slip-line"><span>' + betName(game, id) + '</span><strong>' + format(value) +
    '</strong><button type="button" data-remove="' + id + '" aria-label="移除' + betName(game, id) +
    '"' + (canUpdate() ? '' : ' disabled') + '>×</button></div>').join('') : emptyMessage('选择积分档位，再点选下注项。');
  $('stake-total').textContent = format(total) + ' 积分';
  $('clear').disabled = !total || !canUpdate();
  $('play').disabled = !canUpdate() || sameStakes(selected(), room()?.stakes ?? {}) ||
    total > (state?.balance ?? 0) + confirmed();
  $('play').textContent = pending ? '正在提交…' : total || !confirmed() ? '确认本局下注' : '确认撤回下注';
  $('confirmed').textContent = connected
    ? '已确认 ' + format(confirmed()) + ' 积分 · ' + (confirmed() ? '开奖时自动结算' : '可直接观看开奖') : '正在连接实时牌桌';
  $('status').textContent = notice || (state && state.balance + confirmed() < 1_000 ? '余额不足 10 积分，仍可观看。' : '');
}

function renderSettlement(round) {
  $('last-round').textContent = round ? '第 ' + round.id + ' 局' : '';
  $('settlement').innerHTML = !round ? emptyMessage('等待本桌首次开奖。') :
    '<p class="settled-outcome">' + outcomeText(round) + '</p>' +
    (!round.staked ? emptyMessage('本局没有已确认的下注。') :
      '<div class="settlement-total"><span>净变动</span><strong class="' + tone(round.net) + '">' +
      signed(round.net) + '</strong></div>' + round.lines.map(line =>
      '<div class="settlement-line"><span>' + betName(game, line.id) + '</span><span class="' +
      tone(line.returned - line.amount) + '">' + statusNames[line.status] + ' · 返还 ' + format(line.returned) +
      ' · 净变动 ' + signed(line.returned - line.amount) + '</span></div>').join('') +
      '<div class="settlement-foot">下注 ' + format(round.staked) + ' · 总返还 ' + format(round.returned) + '</div>');
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
  const history = state?.history ?? [];
  $('history-content').innerHTML = history.length ? history.map(round => {
    const lines = round.lines.map(line => '<div class="settlement-line"><span>' + betName(round.game, line.id) +
      '</span><span>' + statusNames[line.status] + ' · 下注 ' + format(line.amount) + ' · 返还 ' +
      format(line.returned) + ' · 净变动 ' + signed(line.returned - line.amount) + '</span></div>').join('');
    return '<details class="history-item"><summary><span><strong>' + GAMES[round.game].name + '</strong> <small>' +
      clock.format(round.time) + '</small></span><strong class="' + tone(round.net) + '">' +
      (round.staked ? signed(round.net) + ' 积分' : '练习') + '</strong></summary><div><p>' +
      outcomeText(round) + '</p>' + lines + '</div></details>';
  }).join('') : emptyMessage('已确认的下注结算后，战绩会显示在这里。');
}

function render() {
  document.querySelectorAll('button[data-game]').forEach(button =>
    button.setAttribute('aria-pressed', button.dataset.game === game));
  renderStage(reveal() ? room().latest : undefined);
  renderBoard();
  renderSlip();
  renderSettlement(room()?.latest);
  if ($('history-dialog').open) renderHistory();
  renderClock();
}

function secondsUntil(time) {
  return Math.max(0, Math.ceil((time - serverTime()) / 1_000));
}

function renderClock() {
  const phase = !connected ? '正在连接' : !canBet() ? '已封盘 · 等待开奖' : '开放下注';
  const active = room();
  $('round-note').textContent = active ? '第 ' + active.id + ' 局 · ' + phase : phase;
  $('round-clock').textContent = connected && active
    ? secondsUntil(canBet() ? active.closesAt : active.revealAt) + ' 秒' : '—';
  $('round-clock').setAttribute('aria-label', canBet() ? '距离封盘' : '距离开奖');
  for (const name of Object.keys(GAMES)) {
    $(name + '-clock').textContent = connected ? secondsUntil(state.rooms[name].revealAt) + '秒' : '';
  }
  timerView = [canBet(), reveal()].join(',');
}

function applySnapshot(next, confirmedGame) {
  if (state && state.user.id !== next.user.id) {
    state = null;
    for (const name of Object.keys(drafts)) delete drafts[name];
  }
  if (state && (next.revision < state.revision ||
      (next.revision === state.revision && next.serverTime < state.serverTime))) return;
  for (const name of Object.keys(GAMES)) {
    const current = next.rooms[name];
    const previous = state?.rooms[name];
    const edited = previous && drafts[name] && !sameStakes(drafts[name].stakes, previous.stakes);
    if (current.id !== previous?.id || name === confirmedGame || !edited) {
      drafts[name] = { stakes: { ...current.stakes } };
    }
  }
  if (state && state.date !== next.date) notice = '北京时间已跨日，已发放今日积分。';
  state = next;
  receivedAt = performance.now();
  connected = true;
  $('account-panel').hidden = true;
  $('top-actions').hidden = false;
  $('game-content').hidden = false;
  render();
}

function restoreButton(attribute, value) {
  [...document.querySelectorAll('button[' + attribute + ']')].find(button =>
    button.getAttribute(attribute) === value)?.focus();
}

function updateBets(event) {
  const button = event.target.closest('[data-bet]');
  if (!button || !canUpdate()) return;
  notice = '';
  if (staked() + denomination * 100 > state.balance + confirmed()) {
    notice = '可用积分不足，请减少下注。';
  } else {
    const id = button.dataset.bet;
    selected()[id] = (selected()[id] ?? 0) + denomination * 100;
  }
  renderBoard();
  renderSlip();
  restoreButton('data-bet', button.dataset.bet);
}

async function confirmTicket() {
  if (!canUpdate() || sameStakes(selected(), room().stakes)) return;
  const activeGame = game;
  const auth = authRevision;
  const { id, version } = room();
  const stakes = { ...selected() };
  pending = true;
  notice = '';
  renderSlip();
  try {
    const response = await fetch('/api/ticket/' + activeGame, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roundId: id, version, stakes }),
      signal: AbortSignal.timeout(8_000),
    });
    const result = await response.json();
    if (auth !== authRevision) return;
    if (response.status === 401) {
      signedOut('登录已过期，请重新登录。');
      return;
    }
    if (!response.ok) {
      if (result.state) applySnapshot(result.state);
      notice = result.error ?? '提交失败，请稍后再试。';
    } else {
      applySnapshot(result, activeGame);
      notice = totalStake(stakes) ? '本局下注已确认。' : '下注已撤回，积分已返还。';
    }
  } catch {
    if (auth === authRevision) notice = '提交结果未能确认，请核对已确认积分。';
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
  if (!button || !canUpdate()) return;
  delete selected()[button.dataset.remove];
  notice = '';
  renderBoard();
  renderSlip();
  restoreButton('data-bet', button.dataset.remove);
});
$('clear').addEventListener('click', () => {
  if (!canUpdate()) return;
  drafts[game] = { stakes: {} };
  notice = '';
  renderBoard();
  renderSlip();
});
$('play').addEventListener('click', confirmTicket);
$('rules-open').addEventListener('click', () => {
  renderRules();
  $('rules-dialog').showModal();
});
$('history-open').addEventListener('click', () => {
  renderHistory();
  $('history-dialog').showModal();
});
function signedOut(message = '') {
  authRevision++;
  stream?.close();
  stream = undefined;
  state = null;
  connected = false;
  pendingGrant = undefined;
  notice = '';
  for (const name of Object.keys(drafts)) delete drafts[name];
  for (const id of ['admin-dialog', 'rules-dialog', 'history-dialog']) {
    if ($(id).open) $(id).close();
  }
  $('account-panel').hidden = false;
  $('top-actions').hidden = true;
  $('game-content').hidden = true;
  $('account-status').textContent = message;
  $('password').value = '';
}

function openStream() {
  stream?.close();
  const live = new EventSource('/api/live');
  stream = live;
  live.addEventListener('message', event => {
    if (stream === live) applySnapshot(JSON.parse(event.data));
  });
  live.addEventListener('signed-out', () => {
    if (stream === live) signedOut('登录已过期或已在其他页面退出。');
  });
  live.addEventListener('error', async () => {
    if (stream !== live) return;
    connected = false;
    render();
    try {
      const response = await fetch('/api/state', { signal: AbortSignal.timeout(5_000) });
      if (stream === live && response.status === 401) signedOut('登录已过期，请重新登录。');
    } catch { /* EventSource will reconnect. */ }
  });
}

function chooseMode(next) {
  if (loginBusy) return;
  mode = next;
  const registering = mode === 'register';
  $('login-mode').setAttribute('aria-pressed', !registering);
  $('register-mode').setAttribute('aria-pressed', registering);
  $('account-title').textContent = registering ? '注册青玉桌' : '登录青玉桌';
  $('account-submit').textContent = registering ? '注册并登录' : '登录';
  $('password').autocomplete = registering ? 'new-password' : 'current-password';
  $('account-hint').hidden = !registering;
  $('account-status').textContent = '';
}

async function requestJson(url, body) {
  const response = await fetch(url, {
    ...(body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }),
    signal: AbortSignal.timeout(8_000),
  });
  return { status: response.status, ok: response.ok, data: await response.json() };
}

$('login-mode').addEventListener('click', () => chooseMode('login'));
$('register-mode').addEventListener('click', () => chooseMode('register'));
$('account-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (loginBusy) return;
  loginBusy = true;
  $('account-submit').disabled = true;
  $('account-status').textContent = '';
  try {
    const result = await requestJson('/api/auth/' + mode, {
      username: $('username').value,
      password: $('password').value,
    });
    if (!result.ok) $('account-status').textContent = result.data.error;
    else {
      authRevision++;
      $('password').value = '';
      applySnapshot(result.data);
      openStream();
    }
  } catch {
    $('account-status').textContent = '服务暂时不可用，请稍后重试。';
  } finally {
    loginBusy = false;
    $('account-submit').disabled = false;
  }
});

$('logout').addEventListener('click', async () => {
  $('logout').disabled = true;
  try {
    const result = await requestJson('/api/auth/logout', {});
    if (!result.ok) throw new Error();
    signedOut('已退出登录。');
  } catch {
    notice = '退出请求未完成，请重试。';
    renderSlip();
  } finally {
    $('logout').disabled = false;
  }
});

function renderAdmin(data) {
  const current = $('grant-account').value;
  const options = data.players.map(player => {
    const label = player.name + ' · ' + format(player.balance) + ' 积分';
    return new Option(label, player.id, false, player.id === current);
  });
  $('grant-account').replaceChildren(new Option('选择一个账户', ''), ...options);
  $('grant-history').replaceChildren(...data.grants.map(grant => {
    const row = document.createElement('p');
    row.className = 'grant-row';
    row.textContent = clock.format(grant.time) + ' · ' + grant.actor + ' → ' + grant.player +
      ' · +' + number.format(grant.points) + ' 积分';
    return row;
  }));
  if (!data.grants.length) $('grant-history').textContent = '暂无发放记录。';
  $('grant-submit').disabled = false;
}

$('admin-open').addEventListener('click', async () => {
  $('grant-status').textContent = '正在读取账户…';
  $('grant-submit').disabled = true;
  $('admin-dialog').showModal();
  try {
    const result = await requestJson('/api/admin');
    if (result.status === 401) return signedOut('登录已过期，请重新登录。');
    if (!result.ok) return $('grant-status').textContent = result.data.error;
    renderAdmin(result.data);
    $('grant-status').textContent = '';
  } catch {
    $('grant-status').textContent = '账户列表暂时不可用。';
  }
});

$('grant-form').addEventListener('submit', async event => {
  event.preventDefault();
  const playerId = $('grant-account').value;
  const points = Number($('grant-points').value);
  if (!playerId || !Number.isSafeInteger(points) || points < 1) {
    $('grant-status').textContent = '请选择账户并输入正整数积分。';
    return;
  }
  if (pendingGrant?.playerId !== playerId || pendingGrant?.points !== points) {
    pendingGrant = { playerId, points, requestId: crypto.randomUUID() };
  }
  $('grant-submit').disabled = true;
  $('grant-status').textContent = '正在发放…';
  try {
    const result = await requestJson('/api/admin/grants', pendingGrant);
    if (result.status === 401) return signedOut('登录已过期，请重新登录。');
    if (!result.ok) return $('grant-status').textContent = result.data.error;
    pendingGrant = undefined;
    $('grant-points').value = '';
    renderAdmin(result.data);
    $('grant-status').textContent = '积分已发放。';
  } catch {
    $('grant-status').textContent = '未收到确认。保持同一账户和金额重试，不会重复发放。';
  } finally {
    $('grant-submit').disabled = false;
  }
});

setInterval(() => {
  if (!state) return;
  if (timerView !== [canBet(), reveal()].join(',')) render();
  else renderClock();
}, 200);

const initialAuth = authRevision;
requestJson('/api/state').then(result => {
  if (initialAuth === authRevision && result.ok) {
    applySnapshot(result.data);
    openStream();
  }
}).catch(() => {});
render();
