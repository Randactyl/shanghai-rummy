// Authoritative game engine. Runs only on the host.
// apply(state, pid, action, ctx) returns a new state or throws RuleError.

import { buildDeck, shuffle, points, dealDrawValue, label, isJoker, defaultRng } from './cards.js';
import {
  ROUNDS, analyzeMeld, layOffOptions, withCardAdded, checkLayDownCounts, isFullyDown, mayPlayOn, describeMeld,
  couldStartMeld,
} from './rules.js';

export const SYSTEM = '#system';
export const HAND_SIZE = 11;
export const BUY_WINDOW_MS = 1200;

export class RuleError extends Error {}
const fail = (msg) => { throw new RuleError(msg); };

export const DEFAULT_SETTINGS = {
  decks: 1,
  decksAuto: true, // follow the suggested deck count until the host changes it
  composeSeconds: 10,
  dealerMethod: 'draw', // 'draw' | 'pick'
  pickedDealer: null,
  mods: {
    wild: true, shanghai: true,
    twoWays: false, crazy: false, gambit: false, seeingDouble: false, restrictive: false,
  },
};

export function suggestedDecks(n) {
  return { normal: Math.max(1, Math.ceil(n / 2)), easier: Math.max(1, Math.ceil((n * 3) / 4)) };
}

export function settingsProblem(settings, nPlayers) {
  if (nPlayers < 2) return 'Need at least 2 players';
  const per = settings.mods.wild ? 54 : 52;
  if (settings.decks * per < nPlayers * HAND_SIZE + 12) return `Not enough cards — add a deck`;
  return null;
}

function log(state, text, kind = 'info', extra = {}) {
  state.logSeq = (state.logSeq || 0) + 1;
  state.log.push({ n: state.logSeq, text, kind, ...extra });
  if (state.log.length > 60) state.log.splice(0, state.log.length - 60);
}

const nameOf = (state, pid) =>
  (state.players.find((p) => p.id === pid) || (state.departed || []).find((p) => p.id === pid))?.name ?? '?';
const seatOf = (state, pid) => state.players.findIndex((p) => p.id === pid);
const reqOf = (state) => ROUNDS[state.round];
const top = (state) => state.discard[state.discard.length - 1] || null;
const n = (state) => state.players.length;

/** Remember which turn each table card arrived on, so players can see what's new. */
function markPlayed(state, ids) {
  state.played ||= {};
  for (const id of ids) state.played[id] = state.turnNo;
}

/** Everyone still in the game has tapped "Ready" during the arrange-hand countdown. */
const allReady = (state) => state.players.every((p) => (state.ready || []).includes(p.id));

export function newGame(players, settings, ctx = {}) {
  const rng = ctx.rng || defaultRng;
  const state = {
    v: 1,
    players: players.map((p) => ({ id: p.id, name: p.name })),
    settings: structuredClone(settings),
    phase: 'dealerDraw',
    round: 0,
    dealer: 0,
    current: 0,
    turnStep: 'draw',
    turnNo: 0,
    deck: [], discard: [], hands: {}, melds: [], down: {},
    scores: [],
    pendingBuy: null, shanghaiPick: null, lastDiscard: null,
    revealed: null, composeUntil: null, dealDraw: null,
    meldSeq: 0, log: [], logSeq: 0,
    ready: [], played: {},
  };
  if (settings.dealerMethod === 'pick' && seatOf(state, settings.pickedDealer) >= 0) {
    state.dealer = seatOf(state, settings.pickedDealer);
    log(state, `${nameOf(state, settings.pickedDealer)} was chosen to deal first.`);
  } else {
    // Each player pulls a card; lowest deals. Redraw on exact ties for lowest.
    const deck = buildDeck(1, settings.mods.wild);
    for (let attempt = 0; attempt < 50; attempt++) {
      const picks = shuffle(deck, rng).slice(0, n(state));
      const draw = state.players.map((p, i) => ({ pid: p.id, card: picks[i] }));
      const lo = Math.min(...draw.map((d) => dealDrawValue(d.card)));
      const lows = draw.filter((d) => dealDrawValue(d.card) === lo);
      if (lows.length === 1) {
        state.dealDraw = draw;
        state.dealer = seatOf(state, lows[0].pid);
        break;
      }
    }
    log(state, `${nameOf(state, state.players[state.dealer].id)} drew the lowest card and deals first.`);
  }
  return state;
}

function drawFromDeck(state, rng) {
  if (!state.deck.length) {
    const keep = state.discard.pop();
    if (state.discard.length) {
      state.deck = shuffle(state.discard.map((d) => d.id), rng);
      state.discard = keep ? [keep] : [];
      log(state, 'The deck ran out — the discard pile was reshuffled.');
    } else if (keep) {
      state.discard = [keep];
    }
  }
  return state.deck.pop() || null;
}

function removeFromHand(state, pid, cardId) {
  const h = state.hands[pid];
  const i = h.indexOf(cardId);
  if (i < 0) fail('That card is not in your hand');
  h.splice(i, 1);
}

function startRound(state, ctx) {
  const rng = ctx.rng || defaultRng;
  if (state.phase === 'roundEnd') {
    state.round += 1;
    state.dealer = (state.dealer + 1) % n(state);
  }
  state.revealed = null;
  if (state.round >= ROUNDS.length) {
    state.phase = 'gameEnd';
    log(state, 'Game over!', 'big');
    return;
  }
  state.deck = shuffle(buildDeck(state.settings.decks, state.settings.mods.wild), rng);
  state.discard = [];
  state.melds = [];
  state.down = {};
  state.hands = {};
  state.pendingBuy = null;
  state.shanghaiPick = null;
  state.lastDiscard = null;
  state.turnNo = 0;
  state.ready = [];
  state.played = {};
  for (const p of state.players) state.hands[p.id] = [];
  for (let c = 0; c < HAND_SIZE; c++) {
    for (let k = 1; k <= n(state); k++) {
      const p = state.players[(state.dealer + k) % n(state)];
      state.hands[p.id].push(state.deck.pop());
    }
  }
  log(state, `Round ${state.round + 1}: ${reqOf(state).label}. ${nameOf(state, state.players[state.dealer].id)} deals.`, 'big');
  state.phase = 'compose';
  const secs = state.settings.composeSeconds | 0;
  state.composeUntil = (ctx.now ?? Date.now()) + secs * 1000;
  if (secs <= 0) flip(state, ctx);
}

function flip(state) {
  const card = state.deck.pop();
  state.discard.push({ id: card, by: null, lock: null });
  state.phase = 'turn';
  state.current = (state.dealer + 1) % n(state);
  state.turnStep = 'draw';
  state.turnNo = 1;
  state.composeUntil = null;
  state.ready = [];
  log(state, `The ${label(card)} was flipped. ${nameOf(state, state.players[state.current].id)} goes first.`);
}

/** outPid is null when the round ended in a stalemate (nobody could go out). */
function endRound(state, outPid) {
  const pts = {};
  for (const p of state.players) pts[p.id] = state.hands[p.id].reduce((s, c) => s + points(c), 0);
  state.scores.push({ round: state.round, out: outPid, pts });
  state.revealed = structuredClone(state.hands);
  state.phase = 'roundEnd';
  state.pendingBuy = null;
  state.shanghaiPick = null;
  state.lastDiscard = null;
  if (outPid) log(state, `${nameOf(state, outPid)} went out! Round ${state.round + 1} is over.`, 'big');
  else log(state, `Stalemate — no card left can be played, so nobody can go out. Round ${state.round + 1} is over and everyone scores their hand.`, 'big');
}

/** Once everyone is fully down, the only way to shrink a hand is to get cards onto the table. If no card left
 *  anywhere (hands, deck, discard) can ever get there, nobody can go out and the deck would cycle forever. */
export function isStalemate(state) {
  if (state.phase !== 'turn') return false;
  const mods = state.settings.mods;
  const req = reqOf(state);
  if (!state.players.every((p) => isFullyDown(state.down[p.id], req))) return false;
  const loose = [...state.players.flatMap((p) => state.hands[p.id] || []), ...state.deck, ...state.discard.map((d) => d.id)];
  const jokerHasHome = (from, i) => state.melds.some((m) => m !== from
    && layOffOptions(m, from.cards[i], mods).some((o) => o.kind === 'add'));
  const reachesTable = (id) => state.melds.some((m) => layOffOptions(m, id, mods)
    .some((o) => o.kind === 'add' || (o.kind === 'swap' && jokerHasHome(m, o.index))));
  if (loose.some(reachesTable)) return false;
  return !(mods.seeingDouble && couldStartMeld(loose, req, mods));
}

function checkOut(state, pid) {
  if (state.hands[pid].length === 0) { endRound(state, pid); return true; }
  return false;
}

export function shanghaiWindowOpen(state) {
  const ld = state.lastDiscard;
  const t = top(state);
  // Open from the discard until the next player draws.
  return !!(state.settings.mods.shanghai && state.phase === 'turn' && state.turnStep === 'draw' && ld && !ld.shanghai
    && ld.turnNo === state.turnNo && t && t.id === ld.id && !state.pendingBuy && !state.shanghaiPick);
}

export function buyOpen(state) {
  const t = top(state);
  return !!(state.phase === 'turn' && state.turnStep === 'play' && t && t.lock !== state.turnNo && !state.shanghaiPick);
}

const isLocked = (state, entry) => entry && entry.lock === state.turnNo;

/** Can this card be played anywhere on the table (by anyone)? Used for Shanghai checks. */
function playableAnywhere(state, cardId) {
  return state.melds.some((m) => layOffOptions(m, cardId, state.settings.mods).some((o) => o.kind === 'add'));
}

function findMeld(state, meldId) {
  const m = state.melds.find((x) => x.id === meldId);
  if (!m) fail('That meld is gone');
  return m;
}

function placeOnMeld(state, meld, cardId, end) {
  const mods = state.settings.mods;
  const opts = layOffOptions(meld, cardId, mods).filter((o) => o.kind === 'add');
  if (!opts.length) fail(`The ${label(cardId)} doesn't fit there`);
  const chosen = opts.find((o) => o.end === (end ?? null)) || (opts.length === 1 || meld.type === 'group' ? opts[0] : null);
  if (!chosen) fail('Choose which end of the run');
  const updated = withCardAdded(meld, cardId, chosen.end, mods);
  state.melds[state.melds.indexOf(meld)] = updated;
  return updated;
}

export function apply(prev, pid, action, ctx = {}) {
  const state = structuredClone(prev);
  state.ver = (state.ver || 0) + 1; // lets a takeover host pick the freshest snapshot
  const rng = ctx.rng || defaultRng;
  const now = ctx.now ?? Date.now();
  const mods = state.settings.mods;
  const isSystem = pid === SYSTEM;
  const t = action?.type;

  if (t === 'dropPlayer') {
    if (!ctx.isHost) fail('Only the host can do that');
    if (action.pid === pid) fail("You can't remove yourself");
    dropPlayer(state, action.pid, rng);
    return state;
  }
  if (t === 'startRound') {
    if (!ctx.isHost && !isSystem) fail('Only the host can do that');
    if (!['dealerDraw', 'roundEnd'].includes(state.phase)) fail('Not now');
    startRound(state, { rng, now });
    return state;
  }
  if (t === 'flip') {
    if (!isSystem && !ctx.isHost) fail('Not allowed');
    if (state.phase !== 'compose') fail('Not now');
    flip(state);
    return state;
  }
  if (t === 'ready') {
    // During the arrange-hand countdown: once everyone is ready, flip early.
    if (state.phase !== 'compose') fail('Not now');
    if (seatOf(state, pid) < 0) fail('You are not in this game');
    const r = new Set(state.ready || []);
    if (action.ready === false) r.delete(pid); else r.add(pid);
    state.ready = [...r];
    if (allReady(state)) {
      log(state, 'Everyone is ready.');
      flip(state);
    }
    return state;
  }
  if (t === 'resolveBuy') {
    if (!isSystem) fail('Not allowed');
    if (!state.pendingBuy) return state;
    resolveBuy(state, rng);
    return state;
  }

  if (state.phase !== 'turn') fail('Wait for the round to start');
  if (seatOf(state, pid) < 0) fail('You are not in this game');
  const me = pid;
  const currentPid = state.players[state.current].id;
  const myTurn = me === currentPid;

  if (state.shanghaiPick && t !== 'shanghaiPick') fail('Waiting for a Shanghai card to be picked');

  switch (t) {
    case 'shanghaiPick': {
      const sp = state.shanghaiPick;
      if (!sp) fail('Nothing to pick');
      if (me !== sp.discarder) fail(`${nameOf(state, sp.discarder)} is picking`);
      const idx = action.index | 0;
      if (idx < 0 || idx >= sp.order.length) fail('Pick a card');
      const card = sp.order[idx];
      removeFromHand(state, sp.caller, card);
      state.hands[me].push(card);
      state.shanghaiPick = null;
      log(state, `${nameOf(state, me)} took a random card from ${nameOf(state, sp.caller)}.`);
      checkOut(state, sp.caller);
      return state;
    }

    case 'draw': {
      if (!myTurn) fail("It's not your turn");
      if (state.turnStep !== 'draw') fail('You already drew');
      if (action.from === 'discard') {
        const tp = top(state);
        if (!tp) fail('The discard pile is empty');
        if (isLocked(state, tp)) fail('That card was Shanghaied — draw from the deck');
        state.discard.pop();
        state.hands[me].push(tp.id);
        log(state, `${nameOf(state, me)} took the ${label(tp.id)} from the discard pile.`);
      } else {
        const c = drawFromDeck(state, rng);
        if (!c) fail('No cards left to draw');
        state.hands[me].push(c);
        log(state, `${nameOf(state, me)} drew from the deck.`);
      }
      state.turnStep = 'play';
      state.lastDiscard = null; // closes the Offensive Shanghai window
      return state;
    }

    case 'buy': {
      if (myTurn) fail("You can't buy on your own turn");
      if (!buyOpen(state)) fail(state.turnStep === 'draw' ? 'You can buy once the current player has drawn' : 'That card is not available to buy');
      if (!state.pendingBuy) {
        state.pendingBuy = { requesters: [], until: now + BUY_WINDOW_MS, card: top(state).id };
        log(state, `${nameOf(state, me)}: "I'll buy that!"`, 'buy');
      }
      if (!state.pendingBuy.requesters.includes(me)) state.pendingBuy.requesters.push(me);
      return state;
    }

    case 'shanghai': {
      // Offensive Shanghai: grab the just-discarded card and play it on the table.
      if (!mods.shanghai) fail('Shanghai is turned off');
      if (!shanghaiWindowOpen(state)) fail('Too late to Shanghai that card');
      const ld = state.lastDiscard;
      if (ld.by === me) fail("You can't Shanghai your own discard");
      const meld = findMeld(state, action.meldId);
      placeOnMeld(state, meld, ld.id, action.end);
      markPlayed(state, [ld.id]);
      state.discard.pop();
      state.lastDiscard = null;
      const order = shuffle(state.hands[me], rng);
      state.shanghaiPick = { caller: me, discarder: ld.by, order };
      log(state, `SHANGHAI! ${nameOf(state, me)} played ${nameOf(state, ld.by)}'s ${label(ld.id)}.`, 'shanghai', { by: me });
      return state;
    }
  }

  // Everything below is the current player's own turn actions.
  if (!myTurn) fail("It's not your turn");
  if (state.turnStep !== 'play') fail('Draw a card first');
  if (state.pendingBuy) fail('Paused — someone is buying');
  const req = reqOf(state);

  switch (t) {
    case 'layDown': {
      const proposed = Array.isArray(action.melds) ? action.melds : [];
      if (!proposed.length) fail('Nothing to lay down');
      const existing = state.down[me] || { groups: 0, runs: 0 };
      if (!mods.gambit && state.down[me] && !mods.seeingDouble) fail("You're already down");
      if (mods.gambit && isFullyDown(state.down[me], req) && !mods.seeingDouble) fail("You're already fully down");
      const hand = state.hands[me].slice();
      const used = new Set();
      const melds = [];
      for (const p of proposed) {
        if (!['group', 'run'].includes(p.type) || !Array.isArray(p.cards)) fail('Bad meld');
        for (const c of p.cards) {
          if (used.has(c) || !hand.includes(c)) fail('Those cards are not all in your hand');
          used.add(c);
        }
        const res = analyzeMeld(p.type, p.cards, mods);
        if (!res.ok) fail(res.err);
        melds.push(res.meld);
      }
      const err = checkLayDownCounts(melds, existing, req, mods);
      if (err) fail(err);
      for (const m of melds) {
        state.meldSeq += 1;
        state.melds.push({ ...m, id: `m${state.meldSeq}`, owner: me });
        for (const c of m.cards) removeFromHand(state, me, c);
        markPlayed(state, m.cards);
      }
      const counts = {
        groups: existing.groups + melds.filter((m) => m.type === 'group').length,
        runs: existing.runs + melds.filter((m) => m.type === 'run').length,
      };
      state.down[me] = counts;
      const full = isFullyDown(counts, req);
      log(state, `${nameOf(state, me)} ${full ? 'is down' : 'laid down'}: ${melds.map((m) => describeMeld(m, mods)).join(', ')}.`, full ? 'down' : 'info');
      checkOut(state, me);
      return state;
    }

    case 'layOff': {
      const meld = findMeld(state, action.meldId);
      if (!mayPlayOn(me, meld, state.down, req, mods)) {
        fail(state.down[me] ? 'Partially-down players can only add to their own cards' : 'You must be down to play on the table');
      }
      if (!state.hands[me].includes(action.cardId)) fail('That card is not in your hand');
      placeOnMeld(state, meld, action.cardId, action.end);
      removeFromHand(state, me, action.cardId);
      markPlayed(state, [action.cardId]);
      log(state, `${nameOf(state, me)} played the ${label(action.cardId)} on ${meld.owner === me ? 'their own' : nameOf(state, meld.owner) + "'s"} ${describeMeld(meld, mods)}.`);
      checkOut(state, me);
      return state;
    }

    case 'swapJoker': {
      if (!mods.wild) fail('Jokers are not in play');
      if (!isFullyDown(state.down[me], req)) fail('Only Down Players can replace a Joker');
      const src = findMeld(state, action.meldId);
      const card = action.cardId;
      if (!state.hands[me].includes(card)) fail('That card is not in your hand');
      const swap = layOffOptions(src, card, mods).find((o) => o.kind === 'swap');
      if (!swap) fail(`The ${label(card)} can't replace that Joker`);
      const jokerId = src.cards[swap.index];
      const tgtId = action.target?.meldId;
      if (!tgtId || tgtId === src.id) fail('Choose another place on the table for the Joker');
      const updatedSrc = { ...src, cards: src.cards.slice() };
      updatedSrc.cards[swap.index] = card;
      state.melds[state.melds.indexOf(src)] = updatedSrc;
      const tgt = findMeld(state, tgtId);
      if (!mayPlayOn(me, tgt, state.down, req, mods)) fail("You can't play the Joker there");
      placeOnMeld(state, tgt, jokerId, action.target.end);
      removeFromHand(state, me, card);
      markPlayed(state, [card, jokerId]);
      log(state, `${nameOf(state, me)} swapped the ${label(card)} for a Joker and moved it to ${tgt.owner === me ? 'their own' : nameOf(state, tgt.owner) + "'s"} ${describeMeld(tgt, mods)}.`);
      checkOut(state, me);
      return state;
    }

    case 'discard': {
      const card = action.cardId;
      if (!state.hands[me].includes(card)) fail('That card is not in your hand');
      const defensive = !!action.shanghai;
      if (defensive) {
        if (!mods.shanghai) fail('Shanghai is turned off');
        if (!playableAnywhere(state, card)) fail(`The ${label(card)} can't be played on the table, so there's nothing to Shanghai`);
      }
      removeFromHand(state, me, card);
      const nextTurn = state.turnNo + 1;
      state.discard.push({ id: card, by: me, lock: defensive ? nextTurn : null });
      if (defensive) log(state, `SHANGHAI! ${nameOf(state, me)} discarded the ${label(card)} defensively.`, 'shanghai', { by: me });
      else log(state, `${nameOf(state, me)} discarded the ${label(card)}.`);
      if (checkOut(state, me)) return state;
      state.current = (state.current + 1) % n(state);
      state.turnNo = nextTurn;
      state.turnStep = 'draw';
      state.lastDiscard = { id: card, by: me, turnNo: nextTurn, shanghai: defensive };
      if (isStalemate(state)) endRound(state, null);
      return state;
    }
  }
  fail('Unknown action');
}

/** Remove a player mid-game. Their hand is shuffled into the deck; their table cards stay put. */
function dropPlayer(state, target, rng) {
  const idx = seatOf(state, target);
  if (idx < 0) fail('That player is not in the game');
  const name = nameOf(state, target);
  const hand = state.hands[target] || [];
  const midRound = state.phase === 'turn' || state.phase === 'compose';
  if (midRound && hand.length) state.deck = shuffle(state.deck.concat(hand), rng);
  delete state.hands[target];
  state.departed = [...(state.departed || []), { id: target, name }];
  const wasCurrent = state.phase === 'turn' && idx === state.current;
  state.players.splice(idx, 1);
  const N = state.players.length;

  // Keep seat pointers on the same people. If the current player left, the turn passes to the
  // next seat, which now sits at the same index. If the dealer left, point at the seat before them,
  // so the next round's dealer is still the player who went first this round.
  if (idx < state.current) state.current -= 1;
  else if (idx === state.current) state.current = idx % N;
  if (idx < state.dealer) state.dealer -= 1;
  else if (idx === state.dealer) state.dealer = (idx - 1 + N) % N;

  if (wasCurrent) {
    // The next player starts fresh. turnNo is kept on purpose: a card Shanghaied against the
    // departed player stays protected from whoever now takes that turn.
    state.turnStep = 'draw';
    state.pendingBuy = null;
  }
  if (state.pendingBuy) {
    state.pendingBuy.requesters = state.pendingBuy.requesters.filter((p) => p !== target);
    if (!state.pendingBuy.requesters.length) state.pendingBuy = null;
  }
  const sp = state.shanghaiPick;
  if (sp && (sp.caller === target || sp.discarder === target)) state.shanghaiPick = null;
  if (state.lastDiscard?.by === target) state.lastDiscard = null; // can't penalize someone who left
  if (state.dealDraw) state.dealDraw = state.dealDraw.filter((d) => d.pid !== target);

  log(state, `${name} was removed from the game${midRound && hand.length ? ` — their ${hand.length} cards were shuffled into the deck` : ''}.`, 'big');
  if (state.ready) state.ready = state.ready.filter((p) => p !== target);
  if (N >= 2 && state.phase === 'compose' && state.ready?.length && allReady(state)) flip(state);
  if (N < 2) {
    state.phase = 'gameEnd';
    state.pendingBuy = null;
    state.shanghaiPick = null;
    log(state, 'Not enough players left — game over.', 'big');
  }
}

function resolveBuy(state, rng) {
  const pb = state.pendingBuy;
  state.pendingBuy = null;
  const tp = top(state);
  if (!tp || tp.id !== pb.card || state.phase !== 'turn') return;
  // Ties go to whoever is next in turn order after the current player.
  const dist = (pid) => (seatOf(state, pid) - state.current + n(state)) % n(state);
  const winner = pb.requesters.slice().sort((a, b) => dist(a) - dist(b))[0];
  state.discard.pop();
  const got = [tp.id];
  for (let i = 0; i < 2; i++) {
    const c = drawFromDeck(state, rng);
    if (c) got.push(c);
  }
  state.hands[winner].push(...got);
  const others = pb.requesters.filter((p) => p !== winner);
  log(state, `${nameOf(state, winner)} bought the ${label(tp.id)} (+${got.length - 1} penalty)${others.length ? ` — beat ${others.map((p) => nameOf(state, p)).join(', ')} on turn order` : ''}.`, 'buy');
}

/** Everything except the secret parts (hands, deck order). Every player gets a copy so that,
 *  if the host vanishes, someone else can rebuild the game from it plus everyone's own hand. */
export function publicSnapshot(state) {
  const { hands, deck, shanghaiPick, ...rest } = state;
  return structuredClone({
    ...rest,
    handCounts: Object.fromEntries(Object.entries(hands).map(([k, v]) => [k, v.length])),
    shanghaiPick: shanghaiPick ? { caller: shanghaiPick.caller, discarder: shanghaiPick.discarder } : null,
  });
}

/** Rebuild a full game from a public snapshot plus the hands players reported to the new host.
 *  Anyone who didn't report (always including the old host) is dealt random cards from the unseen
 *  pool and then dropped, which shuffles them straight back in. That's the same as treating them as
 *  a dropped player: their hand and the deck become one shuffled deck. */
export function rebuildFromSnapshot(snap, reports, newHostPid, oldHostPid, ctx = {}) {
  const rng = ctx.rng || defaultRng;
  const state = structuredClone(snap);
  const handCounts = state.handCounts || {};
  delete state.handCounts;
  const live = state.phase === 'turn' || state.phase === 'compose';
  const all = buildDeck(state.settings.decks, state.settings.mods.wild);
  const valid = new Set(all);
  const used = new Set([...state.melds.flatMap((m) => m.cards), ...state.discard.map((d) => d.id)]);
  state.hands = {};
  const missing = [];
  for (const p of state.players) {
    const rep = p.id === oldHostPid ? null : reports[p.id];
    if (!Array.isArray(rep)) { missing.push(p.id); continue; }
    // Drop anything impossible (already on the table, duplicated, or not a real card).
    const hand = live ? rep.filter((c) => valid.has(c) && !used.has(c) && used.add(c)) : [];
    state.hands[p.id] = hand;
  }
  const pool = shuffle(all.filter((c) => !used.has(c)), rng);
  for (const pid of missing) state.hands[pid] = live ? pool.splice(0, handCounts[pid] || 0) : [];
  state.deck = pool;
  const sp = state.shanghaiPick;
  state.shanghaiPick = sp && state.hands[sp.caller]?.length ? { ...sp, order: shuffle(state.hands[sp.caller], rng) } : null;
  state.pendingBuy = null; // buyers can simply ask again
  log(state, `${nameOf(state, newHostPid)} took over as host.`, 'big');
  missing.sort((a, b) => (a === oldHostPid ? -1 : b === oldHostPid ? 1 : 0));
  let s = state;
  for (const pid of missing) {
    if (pid === newHostPid) continue;
    s = apply(s, newHostPid, { type: 'dropPlayer', pid }, { rng, isHost: true });
  }
  return s;
}

/** The slice of state a given player is allowed to see. */
export function viewFor(state, pid) {
  const totals = {};
  for (const p of state.players) totals[p.id] = state.scores.reduce((s, r) => s + (r.pts[p.id] || 0), 0);
  const tp = top(state);
  const sp = state.shanghaiPick;
  return {
    me: pid,
    phase: state.phase,
    round: state.round,
    req: ROUNDS[Math.min(state.round, ROUNDS.length - 1)],
    settings: state.settings,
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      handCount: state.hands[p.id]?.length ?? 0,
      down: state.down[p.id] || null,
      total: totals[p.id],
    })),
    dealer: state.dealer,
    current: state.current,
    turnStep: state.turnStep,
    turnNo: state.turnNo,
    deckCount: state.deck.length,
    discardTop: tp ? { id: tp.id, locked: tp.lock === state.turnNo, by: tp.by } : null,
    discardCount: state.discard.length,
    melds: state.melds,
    down: state.down,
    hand: state.hands[pid] ? state.hands[pid].slice() : [],
    pendingBuy: state.pendingBuy ? { requesters: state.pendingBuy.requesters, until: state.pendingBuy.until } : null,
    shanghaiPick: sp ? { caller: sp.caller, discarder: sp.discarder, count: sp.order.length } : null,
    shanghaiWindow: shanghaiWindowOpen(state) ? { by: state.lastDiscard.by } : null,
    buyOpen: buyOpen(state),
    scores: state.scores,
    revealed: state.revealed,
    dealDraw: state.dealDraw,
    departed: state.departed || [],
    composeUntil: state.composeUntil,
    ready: state.ready || [],
    played: state.played || {},
    log: state.log.slice(-30),
  };
}
