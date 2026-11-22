import { label, isJoker, isRed, rankOf, suitOf, SUIT_SYMBOL, rankLabel, sortByRank, sortBySuit } from './cards.js';
import { ROUNDS, arrangeRun, analyzeGroup, layOffOptions, mayPlayOn, isFullyDown, describeMeld, checkLayDownCounts, MIN_GROUP, MIN_RUN } from './rules.js';
import { suggestedDecks, settingsProblem } from './engine.js';
import { HostSession } from './host.js';
import { peerHost, peerClient, localHost, localClient } from './net.js';

// ------------------------------------------------------------------ storage / identity

const LOCAL = new URLSearchParams(location.search).has('local'); // same-browser test mode (tabs talk via BroadcastChannel)
const store = LOCAL ? sessionStorage : localStorage;
const sget = (k, d) => { try { const v = store.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const sset = (k, v) => { try { v == null ? store.removeItem(k) : store.setItem(k, JSON.stringify(v)); } catch {} };
const rid = () => Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);

const app = {
  pid: sget('shrum.pid') || (() => { const p = rid(); sset('shrum.pid', p); return p; })(),
  name: sget('shrum.name', ''),
  role: null, // 'host' | 'client'
  code: null,
  session: null,
  client: null,
  view: null,
  status: '',
  clockOffset: 0,
  error: '',
};

const ui = {
  selected: new Set(),
  order: [],
  fresh: new Set(),
  staged: [], // [{type, cards, options?, opt}]
  mode: null, // {kind:'jokerTarget', cardId, meldId} | {kind:'shanghai'}
  modal: null,
  lastLog: null,
  drag: null,
  renderQueued: false,
  roundKey: null,
};

// ------------------------------------------------------------------ card style (per device)

const BACKS = [['blue', 'Classic'], ['red', 'Ruby'], ['green', 'Forest'], ['purple', 'Royal'], ['black', 'Midnight'], ['sunset', 'Sunset']];
const prefs = { back: 'blue', four: false, ...sget('shrum.cards', {}) };
function applyPrefs() {
  document.documentElement.dataset.back = prefs.back;
  document.documentElement.classList.toggle('four-color', !!prefs.four);
  sset('shrum.cards', prefs);
}
applyPrefs();

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
const cleanCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel) => document.querySelector(sel);
const root = $('#app');

// ------------------------------------------------------------------ sessions

const TAKEOVER_AFTER_MS = 10000; // offer "take over hosting" after the host has been unreachable this long
const saveHost = (code) => (data) => sset('shrum.host', { code, data, savedAt: Date.now() });

function hostStatusText(s, detail) {
  return s === 'ready' ? '' : s === 'claiming' ? 'Reclaiming your game code…' : s === 'reconnecting' ? 'Reconnecting to the matchmaking server…' : `Connection problem: ${detail || s}`;
}

function startHosting(code, restore) {
  app.role = 'host';
  app.code = code;
  app.view = null;
  let probe = null;
  const transport = LOCAL ? localHost(code, { onStatus }) : peerHost(code, { onStatus });
  function onStatus(s, detail) {
    if (app.session?.transport !== transport) return;
    // If our code is taken, check whether someone else became host while we were away.
    if (s === 'claiming' && !probe && !LOCAL) probe = probeForNewHost(code, () => { probe = null; });
    if (s === 'ready' && probe) { probe.close(); probe = null; }
    app.status = hostStatusText(s, detail);
    render();
  }
  app.session = new HostSession({ code, host: { id: app.pid, name: app.name || 'Host' }, transport, restore, save: saveHost(code) });
  wireHostSession(app.session);
  history.replaceState(null, '', `${location.pathname}${location.search}#host=${code}`);
}

function wireHostSession(session) {
  session.onHandedOff = (pid) => {
    const name = playerName(app.view, pid);
    sset('shrum.host', null);
    session.close(); // releases the game code so the new host can claim it
    app.session = null;
    toast(`${name} is the host now`);
    setTimeout(() => joinGame(app.code, { quiet: true }), 400);
  };
  session.onHandOffFailed = (name) => toast(`${name} didn't respond — you're still the host`, 'error');
  session.onUpdate((v) => onView(v));
}

/** Old host came back but the code is taken: connect as a player to find out who holds it. */
function probeForNewHost(code, done) {
  const c = peerClient(code);
  c.onStatus((st) => st === 'connected' && c.send({ t: 'hello', pid: app.pid, name: app.name }));
  c.onMessage((m) => {
    if (m?.t === 'view' && m.v.hostId !== app.pid) {
      c.close(); done();
      sset('shrum.host', null);
      app.session?.close(); app.session = null;
      toast(`${playerName(m.v, m.v.hostId)} is hosting now — you've rejoined as a player`);
      joinGame(code, { quiet: true });
    } else if (m?.t === 'reject') {
      c.close(); done();
      sset('shrum.host', null);
      leave();
      app.error = m.reason;
      render();
    }
  });
  return c;
}

function joinGame(code, { quiet = false } = {}) {
  app.role = 'client';
  app.code = code;
  if (!quiet) app.view = null;
  app.status = 'Connecting…';
  app.lostSince = null;
  const c = LOCAL ? localClient(code) : peerClient(code);
  app.client = c;
  c.onStatus((s) => {
    if (app.client !== c) return;
    if (s === 'connected') {
      app.status = '';
      app.lostSince = null;
      // `resume` lets a takeover host rebuild the game from our hand + the last public state we saw.
      c.send({ t: 'hello', pid: app.pid, name: app.name, resume: app.resume });
    } else {
      app.status = s === 'nohost' ? 'Waiting for the host to come back…' : 'Reconnecting…';
      if (app.lastGood && !app.lostSince) {
        app.lostSince = Date.now();
        setTimeout(render, TAKEOVER_AFTER_MS + 100);
      }
    }
    render();
  });
  c.onMessage((m) => {
    if (!m || app.client !== c) return;
    if (app.takeover) {
      // We're trying to take over, but someone is answering on the game code: they win.
      if (m.t === 'view' && m.v.hostId !== app.pid) cancelTakeover(`${playerName(m.v, m.v.hostId)} is hosting`);
      else return;
    }
    if (m.t === 'view') onView(m.v);
    else if (m.t === 'err') toast(m.msg, 'error');
    else if (m.t === 'notice') toast(m.msg);
    else if (m.t === 'becomeHost') becomeHost(c, m.data);
    else if (m.t === 'reject') {
      leave();
      app.error = m.reason;
      render();
    }
  });
  history.replaceState(null, '', `${location.pathname}${location.search}#join=${code}`);
  render();
}

/** The host handed the game to us. */
function becomeHost(c, data) {
  c.send({ t: 'hostAck' });
  setTimeout(() => {
    c.close();
    app.client = null;
    startHosting(app.code, data);
    toast("You're the host now — keep this page open");
  }, 300);
}

/** The host vanished: claim the game code and rebuild the game from everyone's hands. */
function startTakeover() {
  const v = app.lastGood;
  const code = app.code;
  const oldName = playerName(v, v.hostId);
  const transport = LOCAL ? localHost(code, { onStatus }) : peerHost(code, { onStatus });
  const session = new HostSession({ code, host: { id: app.pid, name: app.name }, transport, recovery: { view: v }, save: saveHost(code) });
  app.takeover = { session };
  app.status = 'Taking over as host…';
  render();
  function onStatus(s) {
    if (app.takeover?.session !== session) return;
    if (s === 'ready') {
      app.takeover = null;
      app.client?.close();
      app.client = null;
      app.role = 'host';
      app.session = session;
      app.status = '';
      app.lostSince = null;
      wireHostSession(session);
      history.replaceState(null, '', `${location.pathname}${location.search}#host=${code}`);
    } else if (s === 'claiming') {
      app.status = `Taking over… waiting for ${oldName}'s old connection to expire (can take up to a minute)`;
    }
    render();
  }
}

function cancelTakeover(why) {
  app.takeover?.session.close();
  app.takeover = null;
  toast(`${why} — takeover cancelled`);
}

function leave() {
  if (app.client) { app.client.send({ t: 'leave' }); app.client.close(); }
  if (app.session) app.session.close();
  if (app.takeover) app.takeover.session.close();
  Object.assign(app, { role: null, code: null, session: null, client: null, view: null, status: '', lastGood: null, resume: null, lostSince: null, takeover: null });
  Object.assign(ui, { selected: new Set(), order: [], staged: [], mode: null, modal: null, lastLog: null });
  history.replaceState(null, '', location.pathname + location.search);
  releaseWakeLock();
  render();
}

function act(a) {
  if (app.role === 'host') {
    const err = app.session.act(app.pid, a);
    if (err) toast(err, 'error');
    return !err;
  }
  app.client?.send({ t: 'act', a, rid: rid() });
  return true;
}

function onView(v) {
  app.view = v;
  if (v.now) app.clockOffset = v.now - Date.now();
  if (!v.recovering) {
    app.lastGood = v;
    app.resume = v.game ? { snap: v.snapshot, hand: v.game.hand } : null;
  }
  const g = v.game;
  if (g) {
    syncHand(g);
    announce(g);
    requestWakeLock();
  } else {
    ui.lastLog = null;
  }
  queueRender();
}

const serverNow = () => Date.now() + app.clockOffset;

// ------------------------------------------------------------------ hand bookkeeping

function syncHand(g) {
  const key = `${g.round}:${g.phase === 'dealerDraw' ? 'd' : 'r'}`;
  const newRound = key !== ui.roundKey;
  ui.roundKey = key;
  const inHand = new Set(g.hand);
  if (!ui.order.length) {
    // After a page reload, restore the player's own card arrangement.
    const saved = sget('shrum.order');
    if (saved?.code === app.code && saved.key === key) ui.order = saved.order;
  }
  const prior = newRound ? [] : ui.order.filter((id) => inHand.has(id));
  const have = new Set(prior);
  const added = g.hand.filter((id) => !have.has(id));
  ui.order = prior.concat(added);
  if (newRound) {
    ui.fresh = new Set();
    ui.staged = [];
    ui.mode = null;
  } else if (added.length && added.length <= 4) {
    ui.fresh = new Set(added);
  }
  for (const id of [...ui.selected]) if (!inHand.has(id)) ui.selected.delete(id);
  ui.staged = ui.staged.filter((s) => s.cards.every((c) => inHand.has(c)));
  if (ui.mode?.kind === 'shanghai' && !g.shanghaiWindow) ui.mode = null;
  if (ui.mode?.kind === 'jokerTarget' && !inHand.has(ui.mode.cardId)) ui.mode = null;
}

const stagedIds = () => new Set(ui.staged.flatMap((s) => s.cards));

function announce(g) {
  const maxN = g.log.length ? g.log[g.log.length - 1].n : 0;
  if (ui.lastLog == null) { ui.lastLog = maxN; return; }
  for (const e of g.log) {
    if (e.n <= ui.lastLog) continue;
    if (e.kind === 'shanghai') shanghaiFlash(e.text);
    else if (['buy', 'down', 'big'].includes(e.kind)) toast(e.text, e.kind);
  }
  ui.lastLog = maxN;
}

// ------------------------------------------------------------------ rendering helpers

function cardHTML(id, { cls = '', attrs = '' } = {}) {
  if (isJoker(id)) {
    return `<div class="card joker ${cls}" data-card="${id}" ${attrs} aria-label="Joker"><span class="corner">★</span><span class="pip">JOKER</span></div>`;
  }
  const r = rankLabel(rankOf(id));
  const s = SUIT_SYMBOL[suitOf(id)];
  return `<div class="card ${isRed(id) ? 'red' : 'black'} s-${suitOf(id)} ${cls}" data-card="${id}" ${attrs} aria-label="${esc(label(id))}"><span class="corner">${r}<i>${s}</i></span><span class="pip">${s}</span></div>`;
}
const backHTML = (cls = '', attrs = '') => `<div class="card back ${cls}" ${attrs}></div>`;

const svg = (d, size = 18) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const icon = {
  copy: svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>', 16),
  share: svg('<path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  rules: svg('<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5"/><path d="M9 7h6M9 11h6"/>'),
  scores: svg('<path d="M8 21h8M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>'),
  log: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  menu: svg('<circle cx="5" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="19" cy="12" r="1.2" fill="currentColor"/>'),
  palette: svg('<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.7-.8 1.7-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.8-1.7 1.7-1.7H16a5 5 0 0 0 5-5c0-4.1-4-7.2-9-7.2z"/><circle cx="7.5" cy="11" r="1" fill="currentColor"/><circle cx="10" cy="7" r="1" fill="currentColor"/><circle cx="15" cy="7.5" r="1" fill="currentColor"/>'),
  hand: svg('<rect x="3" y="5" width="11" height="15" rx="2"/><path d="M17 6.5 20 7.6a1.5 1.5 0 0 1 .9 1.9L17.5 19"/>', 14),
};

function playerName(v, pid) {
  const p = (v.game ? [...v.game.players, ...v.game.departed] : v.lobby.players).find((x) => x.id === pid);
  return p ? p.name : '?';
}

function render() {
  if (ui.drag) { ui.renderQueued = true; return; }
  ui.renderQueued = false;
  const v = app.view;
  const html = !app.role ? homeHTML() : !v ? connectingHTML() : v.recovering ? recoveringHTML(v) : !v.game ? lobbyHTML(v) : gameHTML(v);
  // Only touch the DOM when something visible changed, so taps aren't lost to needless re-renders
  // and typed-but-unsaved input on the home screen isn't wiped.
  if (v?.game) sset('shrum.order', { code: app.code, key: ui.roundKey, order: ui.order });
  if (html !== lastHTML.root) {
    const name = $('#name')?.value;
    const jc = $('#joincode')?.value;
    root.innerHTML = html;
    lastHTML.root = html;
    if (name != null && $('#name')) $('#name').value = name;
    if (jc && $('#joincode')) $('#joincode').value = jc;
  }
  renderModal();
  tick();
}
const lastHTML = { root: null, modal: null };
// setTimeout rather than requestAnimationFrame: rAF stalls in background tabs.
let renderTimer = 0;
function queueRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = 0; render(); }, 0);
}

// ------------------------------------------------------------------ home

function homeHTML() {
  const saved = sget('shrum.host');
  const hashJoin = cleanCode((location.hash.match(/join=([A-Za-z0-9]+)/) || [])[1]);
  return `
  <main class="home">
    <header class="brand">
      <div class="suits"><span class="r">♥</span><span>♠</span><span class="r">♦</span><span>♣</span></div>
      <h1>Shanghai Rummy</h1>
      <p class="sub">Play with family, browser to browser.</p>
    </header>
    ${app.error ? `<div class="alert">${esc(app.error)}</div>` : ''}
    <section class="panel">
      <label class="field"><span>Your name</span>
        <input id="name" maxlength="20" autocomplete="nickname" value="${esc(app.name)}" placeholder="e.g. Grandma">
      </label>
    </section>
    <section class="panel">
      <h2>Join a game</h2>
      <div class="row">
        <input id="joincode" class="code-input" maxlength="5" placeholder="CODE" value="${esc(hashJoin)}" autocapitalize="characters" autocomplete="off" spellcheck="false">
        <button class="btn primary" data-act="join">Join</button>
      </div>
    </section>
    <section class="panel">
      <h2>Host a game</h2>
      <p class="muted">Your browser runs the game, so keep this page open until everyone's done.</p>
      <button class="btn primary wide" data-act="host">Host a new game</button>
      ${saved?.code ? `
        <div class="resume">
          <div><b>Game ${esc(saved.code)}</b> <span class="muted">${saved.data?.game ? `round ${Math.min(7, (saved.data.game.round ?? 0) + 1)} of 7` : 'in lobby'} · ${saved.data?.lobby?.players?.length || 0} players</span></div>
          <div class="row"><button class="btn" data-act="resume">Resume hosting</button><button class="btn ghost" data-act="forget">Forget</button></div>
        </div>` : ''}
    </section>
    <footer class="foot muted">
      <button class="link" data-act="rules">How to play</button> · <button class="link" data-act="card-style">Card style</button>
      ${LOCAL ? ' · <b>Local test mode</b> (tabs in this browser only)' : ''}
    </footer>
  </main>`;
}

function readName() {
  const n = ($('#name')?.value || '').trim().slice(0, 20);
  if (!n) { toast('Enter your name first', 'error'); $('#name')?.focus(); return null; }
  app.name = n;
  sset('shrum.name', n);
  return n;
}

function connectingHTML() {
  return `<main class="home"><section class="panel center">
    <div class="spinner"></div>
    <p>${esc(app.status || 'Starting…')}</p>
    <button class="btn ghost" data-act="leave">Cancel</button>
  </section></main>`;
}

// ------------------------------------------------------------------ lobby

const MOD_INFO = [
  ['wild', 'The Wild', 'Jokers are wild. One per Group or Run; Down Players may swap a Joker for the card it stands for.'],
  ['shanghai', 'The Shanghai', 'Call Shanghai defensively on your discard, or steal a playable discard onto the table.'],
  ['twoWays', 'Two Ways', 'Aces are both high and low (K → A → 2 → 3).'],
  ['crazy', 'Crazy Cards', 'Groups are any cards of one suit; Runs are sequences regardless of suit.'],
  ['gambit', 'The Gambit', 'Lay down requirements as you get them. Partially-down players may only add to their own cards.'],
  ['seeingDouble', 'Seeing Double', 'Lay down extra Groups/Runs of the kinds the round requires, when going down or on later turns.'],
  ['restrictive', 'Restrictive Requirements', 'Lay down exactly 3 cards per Group and 4 per Run.'],
];

function lobbyHTML(v) {
  const isHost = app.role === 'host';
  const { players, settings } = v.lobby;
  const sug = suggestedDecks(players.length);
  const problem = settingsProblem(settings, players.length);
  const link = shareLink(v.code);
  const dis = isHost ? '' : 'disabled';
  return `
  <main class="lobby">
    ${statusBar()}
    <header class="lobby-head">
      <div>
        <div class="muted small">Game code</div>
        <div class="bigcode">${esc(v.code)}</div>
      </div>
      <div class="share">
        <button class="btn" data-act="copy" data-text="${esc(link)}">${icon.copy} Copy invite link</button>
        ${navigator.share ? `<button class="btn square" data-act="share" data-text="${esc(link)}" aria-label="Share invite link" title="Share">${icon.share}</button>` : ''}
      </div>
    </header>

    <section class="panel">
      <h2>Players <span class="muted">(${players.length})</span></h2>
      <p class="muted small">Seat order = turn order (clockwise).${isHost ? ' Use the arrows to rearrange.' : ''}</p>
      <ol class="seats">
        ${players.map((p, i) => `
          <li>
            <span class="dot ${p.online ? 'on' : 'off'}" title="${p.online ? 'connected' : 'not connected'}"></span>
            <span class="pname">${esc(p.name)}${p.id === v.hostId ? ' <span class="tag">host</span>' : ''}${p.id === v.me ? ' <span class="tag you">you</span>' : ''}</span>
            ${isHost ? `<span class="seat-ctl">
              <button class="icon-btn" data-act="move" data-pid="${p.id}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">▲</button>
              <button class="icon-btn" data-act="move" data-pid="${p.id}" data-dir="1" ${i === players.length - 1 ? 'disabled' : ''} aria-label="Move down">▼</button>
              ${p.id !== v.hostId ? `<button class="icon-btn" data-act="kick" data-pid="${p.id}" aria-label="Remove">✕</button>` : ''}
            </span>` : ''}
          </li>`).join('')}
      </ol>
    </section>

    <section class="panel">
      <h2>Table settings</h2>
      <div class="setting">
        <div><b>Decks</b><div class="muted small">Suggested for ${players.length}: ${sug.normal} · easier: ${sug.easier}</div></div>
        <div class="stepper">
          <button class="icon-btn" data-act="set-num" data-key="decks" data-delta="-1" ${dis}>−</button>
          <span>${settings.decks}</span>
          <button class="icon-btn" data-act="set-num" data-key="decks" data-delta="1" ${dis}>+</button>
        </div>
      </div>
      <div class="setting">
        <div><b>Time to arrange hand</b><div class="muted small">Before the first card is flipped</div></div>
        <div class="stepper">
          <button class="icon-btn" data-act="set-num" data-key="composeSeconds" data-delta="-5" ${dis}>−</button>
          <span>${settings.composeSeconds}s</span>
          <button class="icon-btn" data-act="set-num" data-key="composeSeconds" data-delta="5" ${dis}>+</button>
        </div>
      </div>
      <div class="setting col">
        <b>First dealer</b>
        <label class="radio"><input type="radio" name="dm" value="draw" ${settings.dealerMethod !== 'pick' ? 'checked' : ''} ${dis}><span>Everyone draws a card — lowest deals</span></label>
        <label class="radio"><input type="radio" name="dm" value="pick" ${settings.dealerMethod === 'pick' ? 'checked' : ''} ${dis}><span>The least experienced player deals:</span></label>
        <select id="picked" class="picked" ${dis}>${players.map((p) => `<option value="${p.id}" ${settings.pickedDealer === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      </div>
      <h3>Gameplay modifiers</h3>
      <div class="mods">
        ${MOD_INFO.map(([k, name, desc]) => `
          <label class="mod ${settings.mods[k] ? 'on' : ''}">
            <input type="checkbox" data-mod="${k}" ${settings.mods[k] ? 'checked' : ''} ${dis}>
            <span><b>${name}</b><span class="muted small">${desc}</span></span>
          </label>`).join('')}
      </div>
    </section>

    <section class="actions-row">
      ${isHost
        ? `<button class="btn primary wide" data-act="start" ${problem ? 'disabled' : ''}>Start game</button>
           ${problem ? `<p class="muted center">${esc(problem)}</p>` : ''}`
        : `<p class="center muted">Waiting for ${esc(playerName(v, v.hostId))} to start the game…</p>`}
      ${isHost && players.some((p) => p.id !== v.hostId && p.online) ? `<button class="btn ghost" data-act="handoff-list">Pass hosting to someone else…</button>` : ''}
      <button class="btn ghost" data-act="${isHost ? 'close-room' : 'leave'}">${isHost ? 'Close game' : 'Leave'}</button>
    </section>
  </main>`;
}

function shareLink(code) {
  return `${location.origin}${location.pathname}${location.search}#join=${code}`;
}

function statusBar() {
  // A guest who has lost the host for a while can offer to take over.
  const v = app.lastGood;
  const lost = app.role === 'client' && !app.takeover && app.lostSince && Date.now() - app.lostSince >= TAKEOVER_AFTER_MS && v;
  if (lost) {
    const hostName = esc(playerName(v, v.hostId));
    return `<div class="statusbar lost">
      <span>Can't reach ${hostName}, the host. If they reopen the page, the game picks up where it left off.</span>
      <button class="btn small" data-act="takeover">Take over hosting</button>
    </div>`;
  }
  return app.status ? `<div class="statusbar">${esc(app.status)}</div>` : '';
}

function recoveringHTML(v) {
  const r = v.recovering;
  const isHost = app.role === 'host';
  const waiting = r.waitingFor;
  return `<main class="home">
    ${statusBar()}
    <section class="panel center">
      <div class="spinner"></div>
      <h2>${isHost ? "You're taking over as host" : `${esc(r.host)} is taking over as host`}</h2>
      <p class="muted">${esc(r.from)} disconnected, so the game is being rebuilt from everyone's hands.
        ${esc(r.from)}'s cards will be shuffled into the deck.</p>
      ${waiting.length ? `<p><b>Waiting for:</b></p>
        <ul class="droplist">${waiting.map((p) => `<li><span class="dot ${p.online ? 'on' : 'off'}"></span><span class="pname">${esc(p.name)}</span></li>`).join('')}</ul>
        ${isHost ? `<p class="muted small">Everyone else reconnects automatically. If someone isn't coming back:</p>
          <button class="btn danger" data-act="finish-recovery">Continue without ${waiting.map((p) => esc(p.name)).join(', ')}</button>` : ''}` : ''}
    </section>
  </main>`;
}

// ------------------------------------------------------------------ game

const cutOff = () => app.role === 'client' && !!app.lostSince;

/** What this player can still lay down, and how the staged melds fill it. */
function downPlan(g, me) {
  const mods = g.settings.mods;
  const req = g.req;
  const have = g.down?.[me] || null;
  const fully = isFullyDown(have, req);
  const active = ['compose', 'turn'].includes(g.phase) && (!have || mods.seeingDouble || (mods.gambit && !fully));
  if (!active) return { active: false };
  const got = have || { groups: 0, runs: 0 };
  const need = { group: Math.max(0, req.groups - got.groups), run: Math.max(0, req.runs - got.runs) };
  const stagedOf = (t) => ui.staged.filter((s) => s.type === t).length;
  const wants = (t) => (t === 'group' ? req.groups : req.runs) > 0 && (mods.seeingDouble || stagedOf(t) < need[t]);
  const melds = ui.staged.map((s) => ({ type: s.type, cards: s.type === 'run' ? s.options[s.opt].cards : s.cards }));
  const problem = ui.staged.length ? checkLayDownCounts(melds, got, req, mods) : 'nothing';
  return { active: true, have, fully, need, wants, melds, ready: !problem, problem };
}

/** Does the current selection make a Group and/or a Run? */
function selectionCheck(g, ids) {
  const mods = g.settings.mods;
  const out = { group: null, run: null, why: '' };
  if (!ids.length) return out;
  const g1 = analyzeGroup(ids, mods);
  const r1 = arrangeRun(ids, mods);
  if (g1.ok && !(mods.restrictive && ids.length !== MIN_GROUP)) out.group = g1;
  if (r1.ok && !(mods.restrictive && ids.length !== MIN_RUN)) out.run = r1;
  if (!out.group && !out.run) {
    const kinds = [g.req.groups > 0 && 'group', g.req.runs > 0 && 'run'].filter(Boolean);
    const min = Math.min(...kinds.map((k) => (k === 'group' ? MIN_GROUP : MIN_RUN)));
    if (ids.length < min) out.why = `${ids.length} selected — pick ${min - ids.length} more`;
    else if (mods.restrictive && g1.ok) out.why = `Restrictive Requirements: exactly ${MIN_GROUP} cards per Group`;
    else if (mods.restrictive && r1.ok) out.why = `Restrictive Requirements: exactly ${MIN_RUN} cards per Run`;
    else out.why = kinds.length === 2 ? `Not a Group or a Run yet` : kinds[0] === 'group' ? g1.err : r1.err;
  }
  return out;
}

const SLOT_HINT = (type, mods) => type === 'group'
  ? (mods.crazy ? '3+ of one suit' : '3+ of the same rank')
  : (mods.crazy ? '4+ in a row, any suits' : '4+ in a row, same suit');

function plannerHTML(g, plan, selCheck, { myTurn, canPlayStep }) {
  const mods = g.settings.mods;
  const slots = [];
  // Staged melds first (in the order they were made), then empty slots for what's still needed.
  ui.staged.forEach((s, i) => {
    const cards = s.type === 'run' ? s.options[s.opt].cards : s.cards;
    slots.push(`<div class="slot filled">
      <div class="staged-head"><span>${s.type === 'run' ? 'Run' : 'Group'} ✓</span>
        ${s.type === 'run' && s.options.length > 1 ? `<button class="icon-btn" data-act="flip-run" data-i="${i}" title="Move the Joker to the other end" aria-label="Move the Joker">⇄</button>` : ''}
        <button class="icon-btn" data-act="unstage" data-i="${i}" aria-label="Put back in hand" title="Put back">✕</button></div>
      <div class="meld">${cards.map((c) => cardHTML(c, { cls: 'mini' })).join('')}</div>
    </div>`);
  });
  for (const type of ['group', 'run']) {
    const missing = plan.need[type] - ui.staged.filter((s) => s.type === type).length;
    for (let k = 0; k < missing; k++) {
      const can = k === 0 && !!selCheck[type];
      slots.push(`<div class="slot empty ${can ? 'can' : ''}" ${can ? `data-act="stage" data-type="${type}" role="button" tabindex="0"` : ''}>
        <b>${type === 'group' ? 'Group' : 'Run'}</b><span>${can ? `Tap to add these ${ui.selected.size}` : SLOT_HINT(type, mods)}</span>
      </div>`);
    }
  }
  const sel = ui.selected.size;
  let hint;
  const fit = selCheck.group && plan.wants('group') ? 'Group' : selCheck.run && plan.wants('run') ? 'Run' : null;
  if (sel && fit) hint = `That's a ${fit}! Tap <b>Make ${fit}</b> to set it aside here.`;
  else if (sel && (selCheck.group || selCheck.run)) hint = `That's a ${selCheck.group ? 'Group' : 'Run'}, but you already have enough of those for this round.`;
  else if (sel) hint = esc(selCheck.why);
  else if (plan.ready) hint = canPlayStep ? 'All set — tap <b>Lay down</b>.' : myTurn ? 'All set — draw a card, then lay down.' : 'All set — lay down when your turn comes.';
  else if (!ui.staged.length && !plan.have) hint = `Tap cards in your hand to select them. ${g.req.groups ? 'A <b>Group</b> is ' + SLOT_HINT('group', mods) + '.' : ''} ${g.req.runs ? 'A <b>Run</b> is ' + SLOT_HINT('run', mods) + '.' : ''}`;
  else if (plan.fully && mods.seeingDouble) hint = 'Seeing Double: you can lay down extra Groups/Runs.';
  else hint = mods.gambit && ui.staged.length ? 'The Gambit: you can lay these down now, or keep going.' : 'Keep going — select the next set.';
  const title = plan.fully ? 'Extra melds' : plan.have ? `Finish going down · ${esc(g.req.label)}` : `Going down · ${esc(g.req.label)}`;
  return `<section class="planner ${plan.ready ? 'ready' : ''}">
    <div class="planner-head"><b>${title}</b>${!myTurn ? '<span class="muted small">planning</span>' : ''}</div>
    ${slots.length ? `<div class="slots">${slots.join('')}</div>` : ''}
    <div class="planner-hint small">${hint}</div>
  </section>`;
}

function gameHTML(v) {
  // Lost the host: show them offline and freeze the table until we're reconnected.
  if (cutOff()) v = { ...v, online: { ...v.online, [v.hostId]: false } };
  const g = v.game;
  const me = v.me;
  const mods = g.settings.mods;
  const cur = g.players[g.current];
  const myTurn = g.phase === 'turn' && cur.id === me;
  const canPlayStep = myTurn && g.turnStep === 'play' && !g.pendingBuy && !g.shanghaiPick;
  const staged = stagedIds();
  const handIds = ui.order.filter((id) => !staged.has(id));
  const targets = computeTargets(v);
  const myDown = g.down?.[me];
  const sel = ui.order.filter((id) => ui.selected.has(id));
  const one = sel.length === 1 ? sel[0] : null;
  const plan = downPlan(g, me);
  const selCheck = plan.active ? selectionCheck(g, sel) : {};
  const compose = g.phase === 'compose';
  const ready = new Set(g.ready || []);

  // ---- players strip
  const strip = g.players.map((p, i) => {
    const down = p.down ? (isFullyDown(p.down, g.req) ? 'Down' : 'Partly down') : '';
    return `<div class="pchip ${i === g.current && g.phase === 'turn' ? 'turn' : ''} ${p.id === me ? 'me' : ''}">
      <div class="pc-top"><span class="dot ${v.online[p.id] ? 'on' : 'off'}"></span><span class="pc-name">${esc(p.name)}</span>${i === g.dealer ? '<span class="tag" title="Dealer">D</span>' : ''}${compose && ready.has(p.id) ? '<span class="tag ok" title="Ready">✓</span>' : ''}</div>
      <div class="pc-meta"><span title="Cards in hand">🂠 ${p.handCount}</span>${down ? `<span class="tag down">${down}</span>` : ''}<span class="muted" title="Total score">${p.total}</span></div>
    </div>`;
  }).join('');

  // ---- status
  let status = '';
  let statusCls = '';
  if (compose) {
    status = `Arrange your hand — first card flips in <b data-until="${g.composeUntil}">…</b> <span class="muted">· ${ready.size}/${g.players.length} ready</span>`;
  } else if (g.phase === 'turn') {
    if (g.shanghaiPick) {
      const sp = g.shanghaiPick;
      statusCls = 'hot';
      status = sp.discarder === me ? `Pick a card from ${esc(playerName(v, sp.caller))}'s hand` : `${esc(playerName(v, sp.discarder))} is picking a card from ${esc(playerName(v, sp.caller))}'s hand…`;
    } else if (g.pendingBuy) {
      statusCls = 'hot';
      status = `⏸ ${g.pendingBuy.requesters.map((p) => esc(playerName(v, p))).join(', ')} buying the ${g.discardTop ? label(g.discardTop.id) : 'card'}…`;
    } else if (ui.mode?.kind === 'shanghai') {
      statusCls = 'hot';
      status = `Shanghai! Tap where the ${label(g.discardTop.id)} goes`;
    } else if (ui.mode?.kind === 'jokerTarget') {
      statusCls = 'hot';
      status = 'Now tap where the Joker goes';
    } else if (myTurn && g.turnStep === 'draw') {
      statusCls = 'mine';
      status = `Your turn — draw from the deck${g.discardTop && !g.discardTop.locked ? ` or take the ${label(g.discardTop.id)}` : ''}`;
    } else if (myTurn) {
      statusCls = 'mine';
      if (one && targets.size) status = 'Tap a glowing meld on the table to play it — or discard it';
      else if (!myDown) status = plan.ready ? 'Ready to go down — tap Lay down' : `Build ${esc(g.req.label)} to go down, or discard to end your turn`;
      else if (plan.active && !plan.fully) status = 'Keep laying down, play on your own cards, or discard';
      else status = 'Select a card to play it on the table, or discard to end your turn';
    } else {
      status = `${esc(cur.name)}'s turn${g.turnStep === 'draw' ? '' : ' · drew a card'}`;
    }
  }

  // ---- table
  // Players who were removed keep their cards on the table (others can still play on them).
  const owners = [...g.players, ...g.departed.map((p) => ({ ...p, left: true }))].filter((p) => g.melds.some((m) => m.owner === p.id));
  const modeActive = targets.size > 0 || !!ui.mode;
  // "Recent" = played during the last lap of turns, i.e. everything since your own previous turn.
  const recentAfter = g.turnNo - g.players.length;
  const isRecent = (c) => (g.played?.[c] ?? -Infinity) > recentAfter;
  const table = owners.length
    ? owners.map((p) => `
      <div class="owner">
        <div class="owner-name">${esc(p.name)}${p.id === me ? ' (you)' : ''}${p.left ? ' (left the game)' : ''}</div>
        <div class="melds">
          ${g.melds.filter((m) => m.owner === p.id).map((m) => {
            const t = targets.get(m.id);
            const isSrc = ui.mode?.kind === 'jokerTarget' && ui.mode.meldId === m.id;
            return `<div class="meld ${t ? 'target' : modeActive ? 'dim' : ''} ${isSrc ? 'source' : ''}" ${t ? `data-act="meld" data-meld="${m.id}" role="button" tabindex="0"` : ''} title="${esc(describeMeld(m, mods))}">
              ${m.cards.map((c) => cardHTML(c, { cls: `mini ${isRecent(c) ? 'recent' : ''}` })).join('')}
            </div>`;
          }).join('')}
        </div>
      </div>`).join('')
    : `<div class="empty-table muted">No cards on the table yet.<br><span class="small">This round: <b>${esc(g.req.label)}</b></span></div>`;

  // ---- piles
  const canDraw = myTurn && g.turnStep === 'draw' && !g.shanghaiPick;
  const dt = g.discardTop;
  const showBuy = g.buyOpen && !myTurn && !(g.pendingBuy?.requesters || []).includes(me) && dt;
  const showShanghai = mods.shanghai && g.shanghaiWindow && g.shanghaiWindow.by !== me && dt && ui.mode?.kind !== 'shanghai';
  const discardLabel = dt?.locked ? '🔒 Shanghaied' : dt?.by ? `From ${esc(dt.by === me ? 'you' : playerName(v, dt.by))}` : `Discard · ${g.discardCount}`;
  const piles = g.phase === 'turn' || g.phase === 'compose' ? `
    <div class="piles">
      <div class="pile">
        ${backHTML(canDraw ? 'can' : '', canDraw ? 'data-act="draw" data-from="deck" role="button" tabindex="0" aria-label="Draw from the deck"' : '')}
        <div class="pile-label">Deck · ${g.deckCount}</div>
      </div>
      <div class="pile">
        ${dt ? cardHTML(dt.id, { cls: `${canDraw && !dt.locked ? 'can' : ''} ${dt.locked ? 'locked' : ''}`, attrs: canDraw && !dt.locked ? 'data-act="draw" data-from="discard" role="button" tabindex="0"' : '' }) : '<div class="card slot"></div>'}
        <div class="pile-label">${discardLabel}</div>
      </div>
      <div class="pile-actions">
        ${showBuy ? `<button class="btn buy" data-act="buy">Buy ${label(dt.id)}<small>+2 penalty cards</small></button>` : ''}
        ${showShanghai ? `<button class="btn shanghai" data-act="shanghai">Shanghai!</button>` : ''}
        ${ui.mode ? `<button class="btn ghost" data-act="cancel-mode">Cancel</button>` : ''}
      </div>
    </div>` : '';

  // ---- actions
  const actions = [];
  if (compose) {
    const iam = ready.has(me);
    actions.push(`<button class="btn ${iam ? 'ghost' : 'primary'}" data-act="ready" data-ready="${iam ? 0 : 1}">${iam ? '✓ Ready (undo)' : "I'm ready"}</button>`);
    if (app.role === 'host') actions.push(`<button class="btn" data-act="flip-now" title="Skip the rest of the countdown">Flip now</button>`);
  }
  if (plan.active && !ui.mode) {
    if (selCheck.group && plan.wants('group')) actions.push(`<button class="btn" data-act="stage" data-type="group">Make Group</button>`);
    if (selCheck.run && plan.wants('run')) actions.push(`<button class="btn" data-act="stage" data-type="run">Make Run</button>`);
  }
  if (canPlayStep) {
    if (ui.staged.length) actions.push(`<button class="btn primary" data-act="laydown" ${plan.ready ? '' : 'disabled'}>Lay down ${ui.staged.length === 1 ? '1 meld' : ui.staged.length + ' melds'}</button>`);
    if (one) {
      actions.push(`<button class="btn danger" data-act="discard">Discard ${label(one)}</button>`);
      if (mods.shanghai) actions.push(`<button class="btn ghost" data-act="discard" data-shanghai="1" title="Discard and block the next player from taking it">Discard + Shanghai</button>`);
    }
  }
  if (sel.length) actions.push(`<button class="btn ghost" data-act="deselect">Clear</button>`);

  return `
  <main class="game ${cutOff() ? 'frozen' : ''}">
    ${statusBar()}
    <header class="topbar">
      <div class="round"><span class="muted">Round ${g.round + 1}/7</span> <b>${esc(g.req.label)}</b></div>
      <div class="top-actions">
        <button class="btn small ghost tb" data-act="scores" aria-label="Scores" title="Scores">${icon.scores}<span>Scores</span></button>
        <button class="btn small ghost tb" data-act="log" aria-label="Game log" title="Game log">${icon.log}<span>Log</span></button>
        <button class="btn small ghost tb" data-act="menu" aria-label="Menu" title="Menu">${icon.menu}</button>
      </div>
    </header>
    <div class="strip">${strip}</div>
    <div class="status ${statusCls}">${status}</div>
    ${offlineNotice(v)}
    <div class="ticker muted small">${g.log.slice(-2).map((e) => esc(e.text)).join('<br>')}</div>
    <section class="table">${table}</section>
    ${piles}
    ${plan.active ? plannerHTML(g, plan, selCheck, { myTurn, canPlayStep }) : ''}
    <section class="hand-wrap">
      <div class="hand-head">
        <span>Your hand <span class="muted">(${handIds.length}${staged.size ? ` + ${staged.size} set aside` : ''})</span></span>
        <span class="sorts"><button class="btn small ghost" data-act="sort" data-by="rank">Sort by rank</button><button class="btn small ghost" data-act="sort" data-by="suit">by suit</button></span>
      </div>
      <div class="hand" id="hand">
        ${handIds.map((id) => cardHTML(id, { cls: `${ui.selected.has(id) ? 'sel' : ''} ${ui.fresh.has(id) ? 'fresh' : ''}`, attrs: 'data-hand="1"' })).join('')}
      </div>
    </section>
    <div class="actionbar ${actions.length ? '' : 'empty'}">${actions.join('')}</div>
  </main>`;
}

/** When the game is stuck waiting on someone who has disconnected, say so (and let the host remove them). */
function offlineNotice(v) {
  const g = v.game;
  if (g.phase !== 'turn' || cutOff()) return '';
  const waitingOn = g.shanghaiPick ? g.shanghaiPick.discarder : g.players[g.current].id;
  if (waitingOn === v.me || v.online[waitingOn] !== false) return '';
  const name = esc(playerName(v, waitingOn));
  return `<div class="offline">
    <span><span class="dot off"></span> ${name} is disconnected. They'll rejoin automatically if they reopen the page.</span>
    ${app.role === 'host' ? `<button class="btn small danger" data-act="drop" data-pid="${waitingOn}">Remove ${name}</button>` : ''}
  </div>`;
}

/** Map meldId -> [{label, action}] for the current interaction mode. */
function computeTargets(v) {
  const g = v.game;
  const me = v.me;
  const mods = g.settings.mods;
  const out = new Map();
  if (g.phase !== 'turn' || g.shanghaiPick || g.pendingBuy) return out;
  const add = (m, entry) => { if (!out.has(m.id)) out.set(m.id, []); out.get(m.id).push(entry); };
  const endLabel = (m, o, card) => (m.type === 'group' ? `Add the ${label(card)}` : `Add the ${label(card)} to the ${o.end} end`);

  if (ui.mode?.kind === 'shanghai') {
    const card = g.discardTop?.id;
    if (!card) return out;
    for (const m of g.melds) for (const o of layOffOptions(m, card, mods)) {
      if (o.kind === 'add') add(m, { label: endLabel(m, o, card), action: { type: 'shanghai', meldId: m.id, end: o.end } });
    }
    return out;
  }
  const myTurn = g.players[g.current].id === me && g.turnStep === 'play';
  if (!myTurn) return out;
  if (ui.mode?.kind === 'jokerTarget') {
    const src = g.melds.find((m) => m.id === ui.mode.meldId);
    const jokerId = src?.cards.find(isJoker);
    if (!jokerId) return out;
    for (const m of g.melds) {
      if (m.id === src.id || !mayPlayOn(me, m, g.down, g.req, mods)) continue;
      for (const o of layOffOptions(m, jokerId, mods)) {
        if (o.kind === 'add') add(m, { label: m.type === 'group' ? 'Put the Joker here' : `Put the Joker on the ${o.end} end`, action: { type: 'swapJoker', meldId: src.id, cardId: ui.mode.cardId, target: { meldId: m.id, end: o.end } } });
      }
    }
    return out;
  }
  if (ui.selected.size !== 1) return out;
  const card = [...ui.selected][0];
  const fully = isFullyDown(g.down[me], g.req);
  for (const m of g.melds) {
    if (!mayPlayOn(me, m, g.down, g.req, mods)) continue;
    for (const o of layOffOptions(m, card, mods)) {
      if (o.kind === 'add') add(m, { label: endLabel(m, o, card), action: { type: 'layOff', meldId: m.id, cardId: card, end: o.end } });
      else if (fully && mods.wild) add(m, { label: `Swap the ${label(card)} for the Joker`, mode: { kind: 'jokerTarget', cardId: card, meldId: m.id } });
    }
  }
  return out;
}

// ------------------------------------------------------------------ modals

function renderModal() {
  const mr = $('#modal-root');
  const forced = forcedModal();
  const m = forced || ui.modal;
  const closable = !forced;
  const html = !m ? '' : `<div class="backdrop" ${closable ? 'data-act="close-modal"' : ''}>
    <div class="modal ${m.cls || ''}" role="dialog" aria-modal="true" aria-label="${esc(m.label || (m.title || '').replace(/<[^>]+>/g, ''))}">
      ${m.title || closable ? `<header class="modal-head">
        <h2>${m.title || ''}</h2>
        ${closable ? `<button class="icon-btn modal-x" data-act="close-modal" aria-label="Close">${icon.close}</button>` : ''}
      </header>` : ''}
      <div class="modal-body">${m.body}</div>
      ${m.buttons ? `<footer class="modal-btns">${m.buttons}</footer>` : ''}
    </div></div>`;
  if (html !== lastHTML.modal) {
    const prevScroll = mr.querySelector('.modal-body')?.scrollTop || 0;
    const same = mr.querySelector('.modal')?.getAttribute('aria-label') === (m && esc(m.label || (m.title || '').replace(/<[^>]+>/g, '')));
    mr.innerHTML = html;
    lastHTML.modal = html;
    // Keep the scroll position when the same dialog re-renders with fresh data.
    if (same && mr.querySelector('.modal-body')) mr.querySelector('.modal-body').scrollTop = prevScroll;
  }
}

function forcedModal() {
  const v = app.view;
  const g = v?.game;
  if (!g) return null;
  const isHost = app.role === 'host';
  if (g.phase === 'dealerDraw') {
    const dealer = g.players[g.dealer];
    return {
      title: 'Who deals first?',
      body: `${g.dealDraw ? `<p class="muted small">Everyone pulled a card — lowest deals (Joker high, Ace high, ties ♥ ♠ ♦ ♣).</p>
        <div class="draws">${g.dealDraw.map((d) => `<div class="draw ${d.pid === dealer.id ? 'win' : ''}">${cardHTML(d.card)}<div>${esc(playerName(v, d.pid))}</div></div>`).join('')}</div>` : ''}
        <p class="center"><b>${esc(dealer.name)}</b> deals first. ${esc(g.players[(g.dealer + 1) % g.players.length].name)} plays first.</p>`,
      buttons: isHost ? `<button class="btn primary" data-act="next-round">Deal round 1</button>` : `<span class="muted">Waiting for the host to deal…</span>`,
    };
  }
  if (g.phase === 'roundEnd' || g.phase === 'gameEnd') {
    const last = g.scores[g.scores.length - 1];
    const final = g.phase === 'gameEnd';
    if (final) {
      const ranked = g.players.slice().sort((a, b) => a.total - b.total);
      return {
        title: `🏆 ${esc(ranked[0].name)} wins!`,
        cls: 'wide',
        body: `<ol class="standings">${ranked.map((p, i) => `<li class="${i === 0 ? 'win' : ''}"><span>${esc(p.name)}</span><b>${p.total}</b></li>`).join('')}</ol>${scoreTable(g)}`,
        buttons: isHost ? `<button class="btn primary" data-act="end-game">Back to lobby</button>` : `<button class="btn ghost" data-act="leave">Leave</button>`,
      };
    }
    return {
      title: `${esc(playerName(v, last.out))} went out!`,
      cls: 'wide',
      body: `<p class="muted center">Round ${last.round + 1} · ${esc(ROUNDS[last.round].label)}</p>
        <div class="results">${g.players.map((p) => `
          <div class="result">
            <div class="res-head"><b>${esc(p.name)}</b><span>+${last.pts[p.id]} <span class="muted">→ ${p.total}</span></span></div>
            <div class="meld">${(g.revealed?.[p.id] || []).map((c) => cardHTML(c, { cls: 'mini' })).join('') || '<span class="muted small">no cards 🎉</span>'}</div>
          </div>`).join('')}</div>`,
      buttons: isHost ? `<button class="btn primary" data-act="next-round">${last.round + 1 >= ROUNDS.length ? 'Final results' : `Deal round ${last.round + 2}`}</button>` : `<span class="muted">Waiting for the host…</span>`,
    };
  }
  if (g.phase === 'turn' && g.shanghaiPick && g.shanghaiPick.discarder === v.me) {
    const sp = g.shanghaiPick;
    return {
      title: 'Shanghai!',
      body: `<p class="center">${esc(playerName(v, sp.caller))} played your discard. Pick one of their cards at random:</p>
        <div class="pick">${Array.from({ length: sp.count }, (_, i) => backHTML('can', `data-act="pick" data-i="${i}" role="button" tabindex="0"`)).join('')}</div>`,
    };
  }
  return null;
}

function scoreTable(g) {
  if (!g.scores.length) return '<p class="muted center">No rounds finished yet.</p>';
  return `<div class="scroll-x"><table class="scores">
    <thead><tr><th>Round</th>${g.players.map((p) => `<th>${esc(p.name)}</th>`).join('')}</tr></thead>
    <tbody>${g.scores.map((s) => `<tr><td>${s.round + 1}</td>${g.players.map((p) => `<td class="${s.out === p.id ? 'out' : ''}">${s.pts[p.id]}</td>`).join('')}</tr>`).join('')}</tbody>
    <tfoot><tr><th>Total</th>${g.players.map((p) => `<th>${p.total}</th>`).join('')}</tr></tfoot>
  </table></div>`;
}

const RULES_HTML = `
  <p><b>Goal:</b> finish all 7 rounds with the lowest score.</p>
  <ol class="rounds">${ROUNDS.map((r) => `<li>${r.label}</li>`).join('')}</ol>
  <p><b>Group:</b> 3+ cards of the same value. <b>Run:</b> 4+ cards of one suit in sequence (Aces high).</p>
  <p><b>Your turn:</b> draw from the deck or discard pile → lay down the round's requirement if you have it (you're now <i>down</i>) → once down, play cards on anyone's table cards → discard.</p>
  <h3>Going down, step by step</h3>
  <ol class="steps">
    <li>Tap cards in your hand to select them, e.g. three 7s.</li>
    <li>When they make a Group or Run, tap <b>Make Group</b> / <b>Make Run</b> (or the glowing slot). They're set aside in the <b>Going down</b> tray.</li>
    <li>Repeat until every slot in the tray is filled, then tap <b>Lay down</b>. You can fill the tray while waiting for your turn.</li>
    <li>Once you're down, select a single card and tap a glowing meld on the table to play it there. Then discard to end your turn.</li>
  </ol>
  <p><b>Buying:</b> after the current player draws, anyone else can buy the top discard. You also take 2 penalty cards. Ties go to whoever's turn comes sooner.</p>
  <p><b>Jokers:</b> wild, one per meld. Down players can swap in the real card and must move the Joker somewhere else on the table.</p>
  <p><b>Shanghai:</b> discarding a card that could be played on the table? Call <i>Discard + Shanghai</i> so the next player can't take it. Forget, and anyone can yell <i>Shanghai!</i>, play it to the table, and pass you a random card from their hand.</p>
  <p><b>Scoring:</b> cards left in hand — Joker 50, Ace 20, K–10 10, 9–2 5.</p>
  <p class="muted small">Going out: the round ends when someone runs out of cards. That can be by discarding their last card or by playing their whole hand.</p>
  <p class="muted small">On the table, cards with a gold outline were played since your last turn.</p>`;

function cardStyleModal() {
  const sample = ['H14.0', 'S13.0', 'D12.0', 'C11.0'];
  return {
    title: 'Card style',
    body: `<p class="muted small center">Only changes how cards look on this device.</p>
      <h3>Card back</h3>
      <div class="backs">${BACKS.map(([k, name]) => `<button class="back-opt ${prefs.back === k ? 'on' : ''}" data-act="set-back" data-back="${k}" aria-pressed="${prefs.back === k}">
        <div class="card back" data-back="${k}"></div><span>${name}</span></button>`).join('')}</div>
      <h3>Suits</h3>
      <label class="mod ${prefs.four ? 'on' : ''}"><input type="checkbox" id="four-color" ${prefs.four ? 'checked' : ''}>
        <span><b>Four-color suits</b><span class="muted small">Diamonds blue and Clubs green, so suits are easier to tell apart.</span></span></label>
      <div class="sample">${sample.map((c) => cardHTML(c)).join('')}</div>`,
    buttons: '<button class="btn primary" data-act="close-modal">Done</button>',
  };
}

// ------------------------------------------------------------------ toasts

function toast(text, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  const box = $('#toasts');
  box.appendChild(el);
  while (box.children.length > 3) box.firstElementChild.remove();
  setTimeout(() => el.classList.add('out'), kind === 'error' ? 3200 : 2600);
  setTimeout(() => el.remove(), kind === 'error' ? 3700 : 3100);
}

function shanghaiFlash(text) {
  const el = document.createElement('div');
  el.className = 'flash';
  el.innerHTML = `<div class="flash-inner"><div class="flash-word">SHANGHAI!</div><div class="flash-text">${esc(text.replace(/^SHANGHAI!\s*/, ''))}</div></div>`;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('out'), 1900);
  setTimeout(() => el.remove(), 2400);
}

// ------------------------------------------------------------------ countdowns

function tick() {
  for (const el of document.querySelectorAll('[data-until]')) {
    const s = Math.max(0, Math.ceil((+el.dataset.until - serverNow()) / 1000));
    el.textContent = `${s}s`;
  }
}
setInterval(tick, 250);

// ------------------------------------------------------------------ actions

const handlers = {
  host() {
    if (!readName()) return;
    if (sget('shrum.host')?.data?.game && !confirm('Start a new game? Your saved game will be forgotten.')) return;
    app.error = '';
    sset('shrum.host', null);
    startHosting(newCode());
  },
  resume() {
    if (!readName()) return;
    const saved = sget('shrum.host');
    if (!saved) return;
    app.error = '';
    startHosting(saved.code, saved.data);
  },
  forget() {
    if (!confirm('Forget the saved game? This cannot be undone.')) return;
    sset('shrum.host', null);
    render();
  },
  join() {
    if (!readName()) return;
    const code = cleanCode($('#joincode')?.value);
    if (code.length !== 5) { toast('Enter the 5-character game code', 'error'); return; }
    app.error = '';
    joinGame(code);
  },
  leave() {
    if (app.view?.game && !confirm('Leave this game? You can rejoin with the same code.')) return;
    leave();
  },
  'close-room'() {
    if (!confirm('Close this game for everyone?')) return;
    sset('shrum.host', null);
    leave();
  },
  rules() { ui.modal = { title: 'How to play', cls: 'wide', body: RULES_HTML, buttons: '<button class="btn primary" data-act="close-modal">Got it</button>' }; renderModal(); },
  'card-style'() { ui.modal = cardStyleModal(); renderModal(); },
  'set-back'(el) { prefs.back = el.dataset.back; applyPrefs(); ui.modal = cardStyleModal(); renderModal(); },
  ready(el) { act({ type: 'ready', ready: el.dataset.ready === '1' }); },
  'flip-now'() { act({ type: 'flip' }); },
  'close-modal'() { ui.modal = null; renderModal(); },
  async copy(el) {
    try { await navigator.clipboard.writeText(el.dataset.text); toast('Invite link copied'); }
    catch { prompt('Copy this link:', el.dataset.text); }
  },
  share(el) { navigator.share?.({ title: 'Shanghai Rummy', text: 'Join my Shanghai Rummy game', url: el.dataset.text }).catch(() => {}); },
  move(el) { app.session?.movePlayer(el.dataset.pid, +el.dataset.dir); },
  kick(el) { app.session?.kick(el.dataset.pid); },
  'set-num'(el) {
    const s = app.view.lobby.settings;
    const k = el.dataset.key;
    const lim = k === 'decks' ? [1, 8] : [0, 60];
    const patch = { [k]: Math.min(lim[1], Math.max(lim[0], s[k] + +el.dataset.delta)) };
    if (k === 'decks') patch.decksAuto = false;
    app.session?.updateSettings(patch);
  },
  start() {
    const err = app.session?.startGame();
    if (err) toast(err, 'error');
  },
  'next-round'() { act({ type: 'startRound' }); },
  'end-game'() { app.session?.endGame(); },
  menu() {
    const isHost = app.role === 'host';
    ui.modal = {
      title: 'Menu',
      body: `<div class="menu">
        <button class="btn wide" data-act="rules">How to play</button>
        <button class="btn wide" data-act="card-style">${icon.palette} Card style</button>
        <div class="row">
          <button class="btn wide" data-act="copy" data-text="${esc(shareLink(app.code))}">${icon.copy} Copy invite link (${esc(app.code)})</button>
          ${navigator.share ? `<button class="btn square" data-act="share" data-text="${esc(shareLink(app.code))}" aria-label="Share invite link" title="Share">${icon.share}</button>` : ''}
        </div>
        ${isHost && app.view.game.players.length > 1 ? `<button class="btn wide" data-act="handoff-list">Pass hosting to someone else…</button>` : ''}
        ${isHost && app.view.game.players.length > 1 ? `<button class="btn wide" data-act="drop-list">Remove a player…</button>` : ''}
        ${isHost ? `<button class="btn wide danger" data-act="abandon">End game for everyone</button>` : `<button class="btn wide ghost" data-act="leave">Leave game</button>`}
      </div>`,
    };
    renderModal();
  },
  takeover() {
    const v = app.lastGood;
    const hostName = playerName(v, v.hostId);
    const inGame = !!v.game;
    const msg = `Take over hosting?\n\n`
      + (inGame ? `${hostName} will be removed from the game and their cards shuffled into the deck. ` : `${hostName} will be removed from the lobby. `)
      + `Everyone else reconnects to you automatically, and you'll need to keep this page open.\n\nOnly do this if ${hostName} isn't coming back.`;
    if (!confirm(msg)) return;
    startTakeover();
  },
  'finish-recovery'() {
    if (!confirm("Continue without them? They'll be removed and their cards shuffled into the deck.")) return;
    app.session?.finishRecovery();
  },
  'handoff-list'() {
    const v = app.view;
    const others = (v.game ? v.game.players : v.lobby.players).filter((p) => p.id !== v.me);
    ui.modal = {
      title: 'Pass hosting',
      body: `<p class="muted small center">The game moves to their browser and you carry on as a regular player. Pick someone with a steady connection who'll keep the page open.</p>
        <ul class="droplist">${others.map((p) => `<li>
          <span class="dot ${v.online[p.id] ? 'on' : 'off'}"></span>
          <span class="pname">${esc(p.name)}</span>
          <button class="btn small" data-act="handoff-to" data-pid="${p.id}" ${v.online[p.id] ? '' : 'disabled'}>Make host</button>
        </li>`).join('')}</ul>`,
      buttons: '<button class="btn ghost" data-act="close-modal">Cancel</button>',
    };
    renderModal();
  },
  'handoff-to'(el) {
    const name = playerName(app.view, el.dataset.pid);
    if (!confirm(`Make ${name} the host?`)) return;
    ui.modal = null;
    renderModal();
    const err = app.session?.handOff(el.dataset.pid);
    if (err) toast(err, 'error');
    else toast(`Handing hosting over to ${name}…`);
  },
  'drop-list'() {
    const v = app.view;
    const others = v.game.players.filter((p) => p.id !== v.me);
    ui.modal = {
      title: 'Remove a player',
      body: `<p class="muted small center">Their hand is shuffled into the deck, their cards on the table stay, and they can't rejoin this game.</p>
        <ul class="droplist">${others.map((p) => `<li>
          <span class="dot ${v.online[p.id] ? 'on' : 'off'}"></span>
          <span class="pname">${esc(p.name)} <span class="muted small">${v.online[p.id] ? 'connected' : 'disconnected'} · ${p.handCount} cards</span></span>
          <button class="btn small danger" data-act="drop" data-pid="${p.id}">Remove</button>
        </li>`).join('')}</ul>`,
      buttons: '<button class="btn ghost" data-act="close-modal">Cancel</button>',
    };
    renderModal();
  },
  drop(el) {
    const v = app.view;
    const p = v.game?.players.find((x) => x.id === el.dataset.pid);
    if (!p) return;
    const midRound = ['turn', 'compose'].includes(v.game.phase);
    const msg = `Remove ${p.name} from the game?\n\n`
      + (midRound ? `Their ${p.handCount} cards will be shuffled into the deck. ` : '')
      + `They won't be able to rejoin, and they won't appear in the final standings.`
      + (v.online[p.id] ? `\n\n${p.name} is still connected.` : '');
    if (!confirm(msg)) return;
    ui.modal = null;
    const err = app.session?.dropPlayer(p.id);
    if (err) toast(err, 'error');
    render();
  },
  abandon() {
    if (!confirm('End this game and return everyone to the lobby? Scores will be lost.')) return;
    ui.modal = null;
    app.session?.endGame();
  },
  scores() { ui.modal = { title: 'Scores', cls: 'wide', body: scoreTable(app.view.game) }; renderModal(); },
  log() {
    const g = app.view.game;
    ui.modal = { title: 'Game log', body: `<ul class="log">${g.log.slice().reverse().map((e) => `<li class="${e.kind}">${esc(e.text)}</li>`).join('')}</ul>` };
    renderModal();
  },
  draw(el) { ui.fresh = new Set(); act({ type: 'draw', from: el.dataset.from }); },
  buy() { act({ type: 'buy' }); },
  shanghai() {
    const g = app.view.game;
    const card = g.discardTop?.id;
    const spots = g.melds.filter((m) => layOffOptions(m, card, g.settings.mods).some((o) => o.kind === 'add'));
    if (!spots.length) { toast(`The ${label(card)} can't be played anywhere on the table`, 'error'); return; }
    ui.mode = { kind: 'shanghai' };
    ui.selected.clear();
    render();
  },
  'cancel-mode'() { ui.mode = null; render(); },
  deselect() { ui.selected.clear(); ui.mode = null; render(); },
  sort(el) {
    const staged = stagedIds();
    const ids = ui.order.filter((id) => !staged.has(id));
    const sorted = el.dataset.by === 'suit' ? sortBySuit(ids) : sortByRank(ids);
    ui.order = sorted.concat(ui.order.filter((id) => staged.has(id)));
    render();
  },
  stage(el) {
    const g = app.view.game;
    const mods = g.settings.mods;
    const ids = ui.order.filter((id) => ui.selected.has(id));
    const plan = downPlan(g, app.view.me);
    if (!plan.active || !plan.wants(el.dataset.type)) return;
    if (el.dataset.type === 'group') {
      const r = analyzeGroup(ids, mods);
      if (!r.ok) return toast(r.err, 'error');
      ui.staged.push({ type: 'group', cards: ids });
    } else {
      const r = arrangeRun(ids, mods);
      if (!r.ok) return toast(r.err, 'error');
      ui.staged.push({ type: 'run', cards: ids, options: r.options, opt: 0 });
    }
    ui.selected.clear();
    render();
  },
  unstage(el) { ui.staged.splice(+el.dataset.i, 1); render(); },
  'flip-run'(el) { const s = ui.staged[+el.dataset.i]; s.opt = (s.opt + 1) % s.options.length; render(); },
  laydown() {
    const g = app.view.game;
    const melds = ui.staged.map((s) => ({ type: s.type, cards: s.type === 'run' ? s.options[s.opt].cards : s.cards }));
    const err = checkLayDownCounts(melds, g.down[app.view.me] || { groups: 0, runs: 0 }, g.req, g.settings.mods);
    if (err) return toast(err, 'error');
    if (act({ type: 'layDown', melds }) && app.role === 'host') ui.staged = [];
  },
  discard(el) {
    const card = [...ui.selected][0];
    if (!card) return;
    // Anything in the Going down tray stays there for next turn.
    act({ type: 'discard', cardId: card, shanghai: !!el.dataset.shanghai });
  },
  meld(el) {
    const opts = computeTargets(app.view).get(el.dataset.meld);
    if (!opts?.length) return;
    if (opts.length === 1) return chooseTarget(opts[0]);
    ui.modal = {
      title: 'Play it where?',
      body: `<div class="menu">${opts.map((o, i) => `<button class="btn wide" data-act="choose" data-i="${i}" data-meld="${el.dataset.meld}">${esc(o.label)}</button>`).join('')}</div>`,
      buttons: '<button class="btn ghost" data-act="close-modal">Cancel</button>',
    };
    renderModal();
  },
  choose(el) {
    const opts = computeTargets(app.view).get(el.dataset.meld);
    ui.modal = null;
    renderModal();
    if (opts?.[+el.dataset.i]) chooseTarget(opts[+el.dataset.i]);
  },
  pick(el) { act({ type: 'shanghaiPick', index: +el.dataset.i }); },
};

function chooseTarget(o) {
  if (o.mode) { ui.mode = o.mode; render(); return; }
  ui.mode = null;
  ui.selected.clear();
  ui.fresh = new Set();
  act(o.action);
  render();
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  if (el.classList.contains('backdrop') && e.target !== el) return; // clicks inside the dialog
  const h = handlers[el.dataset.act];
  if (h) { e.preventDefault(); h(el); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('[role="button"][data-act]')) e.target.click();
  if (e.key === 'Enter' && e.target.id === 'joincode') handlers.join();
  if (e.key === 'Escape' && ui.modal) handlers['close-modal']();
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'four-color') { prefs.four = t.checked; applyPrefs(); ui.modal = cardStyleModal(); renderModal(); return; }
  if (!app.session) return;
  if (t.dataset.mod) app.session.updateSettings({ mods: { [t.dataset.mod]: t.checked } });
  else if (t.name === 'dm') app.session.updateSettings({ dealerMethod: t.value, pickedDealer: t.value === 'pick' ? ($('#picked')?.value || null) : app.view.lobby.settings.pickedDealer });
  else if (t.id === 'picked') app.session.updateSettings({ pickedDealer: t.value, dealerMethod: 'pick' });
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'joincode') e.target.value = cleanCode(e.target.value);
});

// ------------------------------------------------------------------ hand: tap to select, drag to reorder

document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('.card[data-hand]');
  if (!el || e.button > 0) return;
  const r = el.getBoundingClientRect();
  ui.drag = { el, id: el.dataset.card, x0: e.clientX, y0: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, moving: false, pid: e.pointerId };
  el.setPointerCapture(e.pointerId);
});
document.addEventListener('pointermove', (e) => {
  const d = ui.drag;
  if (!d || e.pointerId !== d.pid) return;
  if (!d.moving && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 8) return;
  d.moving = true;
  d.el.classList.add('dragging');
  const hand = $('#hand');
  const others = [...hand.querySelectorAll('.card[data-hand]')].filter((c) => c !== d.el);
  let best = null;
  let bestDist = Infinity;
  for (const c of others) {
    const r = c.getBoundingClientRect();
    const dist = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
    if (dist < bestDist) { bestDist = dist; best = c; }
  }
  if (best) {
    const r = best.getBoundingClientRect();
    const after = e.clientX > r.left + r.width / 2;
    const ref = after ? best.nextSibling : best;
    if (ref !== d.el && d.el.nextSibling !== ref) hand.insertBefore(d.el, ref);
  }
  d.el.style.transform = '';
  const nr = d.el.getBoundingClientRect();
  d.el.style.transform = `translate(${e.clientX - d.dx - nr.left}px, ${e.clientY - d.dy - nr.top}px)`;
});
function endDrag(e) {
  const d = ui.drag;
  if (!d || e.pointerId !== d.pid) return;
  ui.drag = null;
  if (d.moving) {
    const staged = stagedIds();
    const domOrder = [...$('#hand').querySelectorAll('.card[data-hand]')].map((c) => c.dataset.card);
    ui.order = domOrder.concat(ui.order.filter((id) => staged.has(id)));
    render();
  } else if (e.type === 'pointerup') {
    if (ui.mode?.kind === 'shanghai') { ui.mode = null; }
    if (ui.mode?.kind === 'jokerTarget') ui.mode = null;
    ui.selected.has(d.id) ? ui.selected.delete(d.id) : ui.selected.add(d.id);
    render();
  } else if (ui.renderQueued) render();
}
document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);

// ------------------------------------------------------------------ keep the screen awake mid-game; warn host before closing

let wakeLock = null;
async function requestWakeLock() {
  if (wakeLock || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch {}
}
function releaseWakeLock() { wakeLock?.release().catch(() => {}); wakeLock = null; }
document.addEventListener('visibilitychange', () => { if (app.view?.game) requestWakeLock(); });
addEventListener('beforeunload', (e) => {
  if (app.role === 'host' && app.view?.game && app.view.game.phase !== 'gameEnd') { e.preventDefault(); e.returnValue = ''; }
});
addEventListener('hashchange', () => {
  // Following a different invite link while on the home screen.
  if (!app.role) render();
});

// ------------------------------------------------------------------ boot

if (LOCAL) window.__shrum = { app, ui, render }; // test hook, local mode only

(function boot() {
  if (!LOCAL && !window.Peer) app.error = "Couldn't load the networking library. Check your connection and reload.";
  const h = location.hash;
  const hostM = h.match(/host=([A-Z0-9]{5})/i);
  const joinM = h.match(/join=([A-Z0-9]{5})/i);
  const saved = sget('shrum.host');
  if (hostM && saved?.code === cleanCode(hostM[1]) && app.name) startHosting(saved.code, saved.data);
  else if (joinM && app.name) joinGame(cleanCode(joinM[1]));
  render();
})();
