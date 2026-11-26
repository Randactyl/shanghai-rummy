import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrangeRun, analyzeGroup, layOffOptions, validateRunOrder, checkLayDownCounts, ROUNDS } from '../js/rules.js';
import { newGame, apply, viewFor, SYSTEM, DEFAULT_SETTINGS, RuleError } from '../js/engine.js';
import { points, dealDrawValue, buildDeck } from '../js/cards.js';
import { couldStartMeld, layOffPlans } from '../js/rules.js';

const M = (over = {}) => ({ ...DEFAULT_SETTINGS.mods, ...over });

function seeded(seed = 1) {
  let s = seed;
  return (n) => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n; };
}

test('groups', () => {
  assert.ok(analyzeGroup(['H7.0', 'S7.0', 'D7.0'], M()).ok);
  assert.ok(analyzeGroup(['H7.0', 'S7.0', 'X1.0'], M()).ok);
  assert.ok(!analyzeGroup(['H7.0', 'X2.0', 'X1.0'], M()).ok, 'two wilds');
  assert.ok(!analyzeGroup(['H7.0', 'S8.0', 'D7.0'], M()).ok);
  assert.ok(analyzeGroup(['H7.0', 'H9.0', 'H2.0'], M({ crazy: true })).ok);
});

test('runs', () => {
  assert.ok(arrangeRun(['H5.0', 'H6.0', 'H7.0', 'H8.0'], M()).ok);
  assert.ok(!arrangeRun(['H5.0', 'H6.0', 'S7.0', 'H8.0'], M()).ok, 'mixed suit');
  assert.ok(arrangeRun(['H5.0', 'H6.0', 'S7.0', 'H8.0'], M({ crazy: true })).ok);
  const gap = arrangeRun(['H5.0', 'X1.0', 'H7.0', 'H8.0'], M());
  assert.deepEqual(gap.options.map((o) => o.cards), [['H5.0', 'X1.0', 'H7.0', 'H8.0']]);
  const ends = arrangeRun(['H5.0', 'H6.0', 'H7.0', 'X1.0'], M());
  assert.equal(ends.options.length, 2);
  assert.deepEqual(ends.options[0].cards, ['H5.0', 'H6.0', 'H7.0', 'X1.0'], 'joker high preferred');
  // aces high only
  assert.ok(arrangeRun(['HJ', 'H12.0', 'H13.0', 'H14.0'].map((x) => (x === 'HJ' ? 'H11.0' : x)), M()).ok);
  assert.ok(!arrangeRun(['H14.0', 'H2.0', 'H3.0', 'H4.0'], M()).ok, 'A low not allowed');
  assert.ok(arrangeRun(['H14.0', 'H2.0', 'H3.0', 'H4.0'], M({ twoWays: true })).ok);
  assert.ok(arrangeRun(['H13.0', 'H14.0', 'H2.0', 'H3.0'], M({ twoWays: true })).ok, 'wrap K-A-2');
  assert.ok(!arrangeRun(['H13.0', 'H14.0', 'H2.0', 'H3.0'], M()).ok);
  assert.ok(validateRunOrder(['X1.0', 'H5.0', 'H6.0', 'H7.0'], M()).ok);
  assert.ok(!validateRunOrder(['H6.0', 'H5.0', 'H7.0', 'X1.0'], M()).ok);
});

test('lay off and swap options', () => {
  const run = { type: 'run', suit: 'H', start: 5, cards: ['H5.0', 'X1.0', 'H7.0', 'H8.0'] };
  assert.deepEqual(layOffOptions(run, 'H9.0', M()), [{ kind: 'add', end: 'high' }]);
  assert.deepEqual(layOffOptions(run, 'H4.0', M()), [{ kind: 'add', end: 'low' }]);
  assert.deepEqual(layOffOptions(run, 'H6.1', M()), [{ kind: 'swap', index: 1 }]);
  assert.deepEqual(layOffOptions(run, 'X2.0', M()), [], 'second joker not allowed');
  const top = { type: 'run', suit: 'S', start: 11, cards: ['S11.0', 'S12.0', 'S13.0', 'S14.0'] };
  assert.deepEqual(layOffOptions(top, 'S2.0', M()), []);
  const topC = { type: 'run', suit: 'S', start: 11, cards: ['S11.0', 'S12.0', 'S13.0', 'S14.0'] };
  // In cyclic mode a run built under cyclic rules from J..A has start 11 and A=1 at position 3
  assert.deepEqual(layOffOptions(topC, 'S2.0', M({ twoWays: true })), [{ kind: 'add', end: 'high' }]);
  const grp = { type: 'group', rank: 9, cards: ['H9.0', 'S9.0', 'X1.0'] };
  assert.deepEqual(layOffOptions(grp, 'D9.0', M()), [{ kind: 'add', end: null }, { kind: 'swap', index: 2 }]);
});

test('lay down counts', () => {
  const g = { type: 'group', cards: [1, 2, 3] };
  const r = { type: 'run', cards: [1, 2, 3, 4] };
  const z = { groups: 0, runs: 0 };
  assert.equal(checkLayDownCounts([g, g], z, ROUNDS[0], M()), null);
  assert.ok(checkLayDownCounts([g], z, ROUNDS[0], M()));
  assert.ok(checkLayDownCounts([g, g, g], z, ROUNDS[0], M()));
  assert.equal(checkLayDownCounts([g, g, g], z, ROUNDS[0], M({ seeingDouble: true })), null);
  assert.ok(checkLayDownCounts([g, g, r], z, ROUNDS[0], M({ seeingDouble: true })), 'no runs in round 1');
  assert.equal(checkLayDownCounts([g], z, ROUNDS[0], M({ gambit: true })), null);
  assert.match(checkLayDownCounts([{ type: 'group', cards: [1, 2, 3, 4] }], z, ROUNDS[0], M({ gambit: true })), /exactly 3/, 'partials are bare');
  assert.ok(checkLayDownCounts([g, { type: 'group', cards: [1, 2, 3, 4] }], z, ROUNDS[0], M({ restrictive: true })));
});

test('scoring and deal draw values', () => {
  assert.equal(points('X1.0'), 50);
  assert.equal(points('H14.0'), 20);
  assert.equal(points('H10.0'), 10);
  assert.equal(points('H9.0'), 5);
  assert.ok(dealDrawValue('C2.0') < dealDrawValue('H2.0'));
  assert.ok(dealDrawValue('H2.0') < dealDrawValue('C3.0'));
  assert.ok(dealDrawValue('H14.0') < dealDrawValue('X1.0'));
});

function setup(nPlayers = 3, mods = {}, rngSeed = 7) {
  const rng = seeded(rngSeed);
  const players = Array.from({ length: nPlayers }, (_, i) => ({ id: 'p' + i, name: 'P' + i }));
  const settings = { ...DEFAULT_SETTINGS, decks: 2, composeSeconds: 0, mods: M(mods) };
  let s = newGame(players, settings, { rng });
  s = apply(s, SYSTEM, { type: 'startRound' }, { rng, now: 0 });
  return { s, rng };
}

test('full turn cycle, buy with tie-break, shanghai', () => {
  let { s, rng } = setup(4);
  assert.equal(s.phase, 'turn');
  for (const p of s.players) assert.equal(s.hands[p.id].length, 11);
  const cur = () => s.players[s.current].id;
  const p0 = cur();
  assert.throws(() => apply(s, p0, { type: 'discard', cardId: s.hands[p0][0] }), RuleError, 'must draw first');
  s = apply(s, p0, { type: 'draw', from: 'deck' }, { rng });
  assert.equal(s.hands[p0].length, 12);

  // Two others try to buy; the one sooner in turn order wins.
  const seat = s.current;
  const nextP = s.players[(seat + 1) % 4].id;
  const farP = s.players[(seat + 3) % 4].id;
  const topCard = s.discard.at(-1).id;
  s = apply(s, farP, { type: 'buy' }, { rng, now: 0 });
  s = apply(s, nextP, { type: 'buy' }, { rng, now: 10 });
  assert.throws(() => apply(s, p0, { type: 'discard', cardId: s.hands[p0][0] }), /Paused/);
  s = apply(s, SYSTEM, { type: 'resolveBuy' }, { rng });
  assert.equal(s.hands[nextP].length, 14);
  assert.ok(s.hands[nextP].includes(topCard));
  assert.equal(s.hands[farP].length, 11);

  // Discard, next player's turn
  const d = s.hands[p0][0];
  s = apply(s, p0, { type: 'discard', cardId: d }, { rng });
  assert.equal(cur(), nextP);
  assert.equal(viewFor(s, farP).discardTop.id, d);

  // Hidden info: views only contain own hand.
  const v = viewFor(s, farP);
  assert.equal(v.hand.length, 11);
  assert.ok(!JSON.stringify(v).includes(JSON.stringify(s.hands[nextP])));
});

test('lay down, lay off, offensive shanghai, going out', () => {
  let { s, rng } = setup(2);
  const [a, b] = [s.players[s.current].id, s.players[(s.current + 1) % 2].id];
  // Rig hands for round 1 (two groups)
  s.hands[a] = ['H7.0', 'S7.0', 'D7.0', 'H9.0', 'S9.0', 'X1.0', 'C2.0', 'C4.0', 'C6.0', 'D11.0', 'D13.0'];
  s.hands[b] = ['H3.0', 'S5.0', 'D9.0', 'C9.0', 'H10.0', 'S11.0', 'D12.0', 'C13.0', 'H14.0', 'S8.0', 'C8.0'];
  s.deck.push('C7.0'); // a draws this
  s = apply(s, a, { type: 'draw', from: 'deck' }, { rng });
  assert.throws(() => apply(s, a, { type: 'layDown', melds: [{ type: 'group', cards: ['H7.0', 'S7.0', 'D7.0'] }] }), /need/);
  s = apply(s, a, { type: 'layDown', melds: [
    { type: 'group', cards: ['H7.0', 'S7.0', 'D7.0'] },
    { type: 'group', cards: ['H9.0', 'S9.0', 'X1.0'] },
  ] }, { rng });
  assert.ok(s.down[a]);
  const g7 = s.melds[0].id;
  s = apply(s, a, { type: 'layOff', meldId: g7, cardId: 'C7.0' }, { rng });
  assert.equal(s.melds[0].cards.length, 4);

  // b is not down: cannot lay off
  // a discards a 9 that is playable -> b calls offensive shanghai
  s.hands[a].push('D9.1');
  s = apply(s, a, { type: 'discard', cardId: 'D9.1' }, { rng });
  assert.ok(viewFor(s, b).shanghaiWindow);
  assert.throws(() => apply(s, a, { type: 'shanghai', meldId: s.melds[1].id }), /own discard/);
  const bBefore = s.hands[b].length;
  s = apply(s, b, { type: 'shanghai', meldId: s.melds[1].id }, { rng });
  assert.ok(s.shanghaiPick);
  assert.throws(() => apply(s, b, { type: 'draw', from: 'deck' }), /picked/);
  const aBefore = s.hands[a].length;
  s = apply(s, a, { type: 'shanghaiPick', index: 0 }, { rng });
  assert.equal(s.hands[a].length, aBefore + 1);
  assert.equal(s.hands[b].length, bBefore - 1);

  // Joker swap: a's turn later. b draws & discards first.
  s = apply(s, b, { type: 'draw', from: 'deck' }, { rng });
  s = apply(s, b, { type: 'discard', cardId: s.hands[b][0] }, { rng });
  s = apply(s, a, { type: 'draw', from: 'deck' }, { rng });
  s.hands[a].push('C9.1');
  s = apply(s, a, { type: 'swapJoker', meldId: s.melds[1].id, cardId: 'C9.1', target: { meldId: g7 } }, { rng });
  assert.ok(s.melds[0].cards.includes('X1.0'));
  assert.ok(!s.melds[1].cards.includes('X1.0'));

  // Go out by discarding last card
  s.hands[a] = ['C3.0'];
  s = apply(s, a, { type: 'discard', cardId: 'C3.0' }, { rng });
  assert.equal(s.phase, 'roundEnd');
  assert.equal(s.scores[0].pts[a], 0);
  assert.ok(s.scores[0].pts[b] > 0);
  s = apply(s, SYSTEM, { type: 'startRound' }, { rng, now: 0 });
  assert.equal(s.round, 1);
  assert.equal(s.phase, 'turn');
});

test('defensive shanghai locks the card for one turn', () => {
  let { s, rng } = setup(3);
  const a = s.players[s.current].id;
  const b = s.players[(s.current + 1) % 3].id;
  const c = s.players[(s.current + 2) % 3].id;
  s.melds.push({ id: 'mx', owner: c, type: 'group', rank: 5, cards: ['H5.1', 'S5.1', 'C5.1'] });
  s.down[c] = { groups: 2, runs: 0 };
  s = apply(s, a, { type: 'draw', from: 'deck' }, { rng });
  s.hands[a].push('D5.1', 'D6.1');
  assert.throws(() => apply(s, a, { type: 'discard', cardId: 'D6.1', shanghai: true }), /nothing to Shanghai/);
  s = apply(s, a, { type: 'discard', cardId: 'D5.1', shanghai: true }, { rng });
  assert.throws(() => apply(s, b, { type: 'draw', from: 'discard' }), /Shanghaied/);
  assert.throws(() => apply(s, c, { type: 'shanghai', meldId: 'mx' }), /Too late/);
  s = apply(s, b, { type: 'draw', from: 'deck' }, { rng });
  assert.throws(() => apply(s, c, { type: 'buy' }, { now: 0 }), /not available/);
  s = apply(s, b, { type: 'discard', cardId: s.hands[b][0] }, { rng });
  // Card now covered; c draws the covering card, exposing the D5 again on c's turn
  s = apply(s, c, { type: 'draw', from: 'discard' }, { rng });
  assert.equal(s.discard.at(-1).id, 'D5.1');
  s = apply(s, a, { type: 'buy' }, { rng, now: 0 });
  s = apply(s, SYSTEM, { type: 'resolveBuy' }, { rng });
  assert.ok(s.hands[a].includes('D5.1'));
});

test('lay off several cards at once', () => {
  const run = { type: 'run', suit: 'H', start: 4, cards: ['H4.0', 'H5.0', 'H6.0', 'H7.0'] };
  // The 2 only fits once the 3 is on, whichever order they were selected in.
  const [p] = layOffPlans(run, ['H2.0', 'H3.0'], M());
  assert.deepEqual(p.steps, [{ cardId: 'H3.0', end: 'low' }, { cardId: 'H2.0', end: 'low' }]);
  assert.deepEqual(p.meld.cards, ['H2.0', 'H3.0', 'H4.0', 'H5.0', 'H6.0', 'H7.0']);
  assert.equal(layOffPlans(run, ['H3.0', 'H8.0'], M()).length, 1, 'both ends');
  assert.deepEqual(layOffPlans(run, ['H2.0', 'H8.0'], M()), [], 'the 2 has a gap');
  assert.equal(layOffPlans(run, ['H3.0', 'X1.0'], M()).length, 2, 'Joker below the 3 or on top');
  const grp = { type: 'group', rank: 9, cards: ['H9.0', 'S9.0', 'D9.0'] };
  assert.equal(layOffPlans(grp, ['C9.0', 'H9.1', 'X1.0'], M()).length, 1);
  assert.deepEqual(layOffPlans(grp, ['C9.0', 'H8.0'], M()), []);

  let { s, rng } = setup(2);
  const a = s.players[s.current].id;
  const b = s.players[(s.current + 1) % 2].id;
  s.down[a] = { groups: 2, runs: 0 };
  s.melds.push({ id: 'mb', owner: b, ...run });
  s.hands[a].push('H2.1', 'H3.1');
  s = apply(s, a, { type: 'draw', from: 'deck' }, { rng });
  assert.throws(() => apply(s, a, { type: 'layOff', meldId: 'mb', cards: [{ cardId: 'H2.1', end: 'low' }, { cardId: 'H3.1', end: 'low' }] }), /doesn't fit/);
  const before = s.hands[a].length;
  s = apply(s, a, { type: 'layOff', meldId: 'mb', cards: [{ cardId: 'H3.1', end: 'low' }, { cardId: 'H2.1', end: 'low' }] }, { rng });
  assert.deepEqual(s.melds.at(-1).cards, ['H2.1', 'H3.1', 'H4.0', 'H5.0', 'H6.0', 'H7.0']);
  assert.equal(s.hands[a].length, before - 2);
  assert.match(s.log.at(-1).text, /played the 3♥ and 2♥ on/);
});

test('round 7: going out by laying everything down without a discard', () => {
  let { s, rng } = setup(2);
  s.round = 6;
  const a = s.players[s.current].id;
  s.hands[a] = ['H2.0', 'H3.0', 'H4.0', 'H5.0', 'S2.0', 'S3.0', 'S4.0', 'S5.0', 'D2.0', 'D3.0', 'D4.0'];
  s.deck.push('D5.0');
  s = apply(s, a, { type: 'draw', from: 'deck' }, { rng });
  s = apply(s, a, { type: 'layDown', melds: [
    { type: 'run', cards: ['H2.0', 'H3.0', 'H4.0', 'H5.0'] },
    { type: 'run', cards: ['S2.0', 'S3.0', 'S4.0', 'S5.0'] },
    { type: 'run', cards: ['D2.0', 'D3.0', 'D4.0', 'D5.0'] },
  ] }, { rng });
  assert.equal(s.phase, 'roundEnd');
  s = apply(s, SYSTEM, { type: 'startRound' }, { rng });
  assert.equal(s.phase, 'gameEnd');
});

test('gambit: partly-down players lay down the bare requirement and stay off the table', () => {
  let { s, rng } = setup(2, { gambit: true });
  s.round = 1; // one run, one group
  const a = s.players[s.current].id;
  const b = s.players[(s.current + 1) % 2].id;
  s.melds.push({ id: 'mb', owner: b, type: 'group', rank: 12, cards: ['H12.1', 'S12.1', 'C12.1'] });
  s.down[b] = { groups: 1, runs: 1 };
  s.hands[a].push('H8.1', 'S8.1', 'D8.1', 'C8.1', 'D12.1', 'S3.1', 'S4.1', 'S5.1', 'S6.1', 'S7.1');
  s = apply(s, a, { type: 'draw', from: 'deck' }, { rng });
  assert.throws(() => apply(s, a, { type: 'layDown', melds: [{ type: 'group', cards: ['H8.1', 'S8.1', 'D8.1', 'C8.1'] }] }), /exactly 3/);
  s = apply(s, a, { type: 'layDown', melds: [{ type: 'group', cards: ['H8.1', 'S8.1', 'D8.1'] }] }, { rng });
  assert.deepEqual(s.down[a], { groups: 1, runs: 0 });
  const own = s.melds.at(-1).id;
  assert.throws(() => apply(s, a, { type: 'layDown', melds: [{ type: 'group', cards: ['H8.1', 'S8.1', 'D8.1'] }] }), RuleError);
  assert.throws(() => apply(s, a, { type: 'layOff', meldId: own, cardId: 'C8.1' }), /Finish going down/, 'not even on your own meld');
  assert.throws(() => apply(s, a, { type: 'layOff', meldId: 'mb', cardId: 'D12.1' }), /Finish going down/);
  // The lay-down that finishes the requirement follows the normal rules, so it can be long.
  s = apply(s, a, { type: 'layDown', melds: [{ type: 'run', cards: ['S3.1', 'S4.1', 'S5.1', 'S6.1', 'S7.1'] }] }, { rng });
  assert.deepEqual(s.down[a], { groups: 1, runs: 1 });
  s = apply(s, a, { type: 'layOff', meldId: own, cardId: 'C8.1' }, { rng });
  s = apply(s, a, { type: 'layOff', meldId: 'mb', cardId: 'D12.1' }, { rng });
});

test('gambit: extra copies wait until you are fully down', () => {
  const g = { type: 'group', cards: [1, 2, 3] };
  const z = { groups: 0, runs: 0 };
  const sd = M({ gambit: true, seeingDouble: true });
  assert.match(checkLayDownCounts([g, g, g], z, ROUNDS[3], sd), /fully down/, 'three Groups, no Run yet');
  assert.equal(checkLayDownCounts([g, g], z, ROUNDS[3], sd), null);
  assert.equal(checkLayDownCounts([g, g, g], z, ROUNDS[0], sd), null, 'fully down, so the extra is fine');
});

test("gambit: you can't go out until you're fully down", () => {
  let { s, rng } = setup(2, { gambit: true });
  s.round = 1; // one run, one group
  const a = s.players[s.current].id;
  const b = s.players[(s.current + 1) % 2].id;
  // Laying down your last cards as a partial would be going out.
  s.hands[a] = ['H8.1', 'S8.1', 'D8.1'];
  s = apply(s, a, { type: 'draw', from: 'deck' }, { rng });
  assert.throws(() => apply(s, a, { type: 'layDown', melds: [{ type: 'group', cards: ['H8.1', 'S8.1', 'D8.1'] }] }), /fully down/);
  // So would handing over your last card for an Offensive Shanghai.
  s.melds.push({ id: 'm9', owner: a, type: 'group', rank: 9, cards: ['H9.0', 'S9.0', 'D9.0'] });
  s.down[a] = { groups: 1, runs: 1 };
  s.hands[a].push('C9.1');
  s.hands[b] = ['C2.0'];
  s.down[b] = { groups: 1, runs: 0 };
  s = apply(s, a, { type: 'discard', cardId: 'C9.1' }, { rng });
  assert.throws(() => apply(s, b, { type: 'shanghai', meldId: 'm9' }), /fully down/);
  s.hands[b].push('C3.0');
  s = apply(s, b, { type: 'shanghai', meldId: 'm9' }, { rng });
  assert.equal(s.shanghaiPick.caller, b);
});

test('drop: current player mid-turn — hand goes to deck, turn passes, seats stay aligned', () => {
  let { s, rng } = setup(4);
  const seat = (id) => s.players.findIndex((p) => p.id === id);
  const order = s.players.map((p) => p.id);
  const cur = order[s.current];
  const next = order[(s.current + 1) % 4];
  const dealer = order[s.dealer];
  s = apply(s, cur, { type: 'draw', from: 'deck' }, { rng });
  const deckBefore = s.deck.length;
  assert.throws(() => apply(s, next, { type: 'dropPlayer', pid: cur }), /host/);
  s = apply(s, dealer, { type: 'dropPlayer', pid: cur }, { rng, isHost: true });
  assert.equal(s.players.length, 3);
  assert.equal(s.deck.length, deckBefore + 12);
  assert.equal(s.hands[cur], undefined);
  assert.equal(s.players[s.current].id, next, 'turn passes to the next seat');
  assert.equal(s.turnStep, 'draw');
  assert.equal(s.players[s.dealer].id, dealer, 'dealer pointer unchanged');
  assert.equal(viewFor(s, next).departed[0].id, cur);
  // play continues normally
  s = apply(s, next, { type: 'draw', from: 'deck' }, { rng });
  s = apply(s, next, { type: 'discard', cardId: s.hands[next][0] }, { rng });
  assert.equal(s.current, (seat(next) + 1) % 3, 'rotation continues over the remaining 3 seats');
});

test('drop: dealer leaves — next round is dealt by the player who went first', () => {
  let { s, rng } = setup(3);
  const dealer = s.players[s.dealer].id;
  const first = s.players[s.current].id;
  const host = s.players.find((p) => p.id !== dealer && p.id !== first).id;
  s = apply(s, host, { type: 'dropPlayer', pid: dealer }, { rng, isHost: true });
  assert.equal(s.players[s.current].id, first, 'current player unaffected');
  s.hands[first] = ['C3.0'];
  s = apply(s, first, { type: 'draw', from: 'deck' }, { rng });
  s.hands[first] = ['C3.0'];
  s = apply(s, first, { type: 'discard', cardId: 'C3.0' }, { rng });
  assert.equal(s.phase, 'roundEnd');
  s = apply(s, SYSTEM, { type: 'startRound' }, { rng });
  assert.equal(s.players[s.dealer].id, first);
});

test('drop: cancels a pending Shanghai pick, and ends the game below 2 players', () => {
  let { s, rng } = setup(2);
  const [a, b] = [s.players[s.current].id, s.players[(s.current + 1) % 2].id];
  s.shanghaiPick = { caller: b, discarder: a, order: s.hands[b].slice() };
  s = apply(s, a, { type: 'dropPlayer', pid: b }, { rng, isHost: true });
  assert.equal(s.shanghaiPick, null);
  assert.equal(s.phase, 'gameEnd');
  assert.throws(() => apply(s, a, { type: 'dropPlayer', pid: a }, { isHost: true }), /yourself/);
});

test('rebuild after host loss: survivors keep hands, host + deck become one shuffled deck', async () => {
  const { publicSnapshot, rebuildFromSnapshot } = await import('../js/engine.js');
  let { s, rng } = setup(4);
  const [h, b, c, d] = s.players.map((p) => p.id);
  const cur = s.players[s.current].id;
  s = apply(s, cur, { type: 'draw', from: 'deck' }, { rng });
  s = apply(s, cur, { type: 'discard', cardId: s.hands[cur][0] }, { rng });
  const snap = publicSnapshot(s);
  assert.equal(snap.hands, undefined);
  assert.equal(snap.deck, undefined);
  const total = s.deck.length + s.hands[h].length;
  // b is the new host; c reported; d never showed up
  const r = rebuildFromSnapshot(snap, { [b]: s.hands[b], [c]: s.hands[c] }, b, h, { rng });
  assert.deepEqual(r.players.map((p) => p.id).sort(), [b, c].sort());
  assert.deepEqual(r.hands[b], s.hands[b]);
  assert.deepEqual(r.hands[c], s.hands[c]);
  assert.equal(r.deck.length, total + s.hands[d].length);
  assert.deepEqual(r.departed.map((p) => p.id), [h, d], 'old host dropped first');
  // every card accounted for exactly once
  const everything = [...r.deck, ...Object.values(r.hands).flat(), ...r.discard.map((x) => x.id), ...r.melds.flatMap((m) => m.cards)];
  assert.equal(new Set(everything).size, everything.length);
  assert.equal(everything.length, 2 * 54);
  assert.ok(r.log.some((e) => /took over as host/.test(e.text)));
});

test('offensive Shanghai window closes when the next player draws', () => {
  let { s, rng } = setup(3);
  const [a, b, c] = [0, 1, 2].map((k) => s.players[(s.current + k) % 3].id);
  s.melds.push({ id: 'mx', owner: c, type: 'group', rank: 5, cards: ['H5.1', 'S5.1', 'C5.1'] });
  s.down[c] = { groups: 2, runs: 0 };
  s = apply(s, a, { type: 'draw', from: 'deck' }, { rng });
  s.hands[a].push('D5.1');
  s = apply(s, a, { type: 'discard', cardId: 'D5.1' }, { rng });
  assert.ok(viewFor(s, c).shanghaiWindow, 'open right after the discard');
  s = apply(s, b, { type: 'draw', from: 'deck' }, { rng });
  assert.equal(viewFor(s, c).shanghaiWindow, null, 'closed once the next player draws, even from the deck');
  assert.throws(() => apply(s, c, { type: 'shanghai', meldId: 'mx' }), /Too late/);
});

test('Seeing Double: extra required-type melds on later turns', () => {
  let { s, rng } = setup(2, { seeingDouble: true });
  const a = s.players[s.current].id;
  s.down[a] = { groups: 2, runs: 0 };
  s.hands[a].push('H6.1', 'S6.1', 'D6.1', 'H8.1', 'S8.1', 'D8.1', 'C8.1');
  s = apply(s, a, { type: 'draw', from: 'deck' }, { rng });
  s = apply(s, a, { type: 'layDown', melds: [{ type: 'group', cards: ['H6.1', 'S6.1', 'D6.1'] }] }, { rng });
  assert.deepEqual(s.down[a], { groups: 3, runs: 0 });
  assert.throws(() => apply(s, a, { type: 'layDown', melds: [{ type: 'run', cards: ['H8.1', 'S8.1', 'D8.1', 'C8.1'] }] }), RuleError);
  let t = setup(2).s; // without the modifier it's refused
  const b = t.players[t.current].id;
  t.down[b] = { groups: 2, runs: 0 };
  t.hands[b].push('H6.1', 'S6.1', 'D6.1');
  t = apply(t, b, { type: 'draw', from: 'deck' });
  assert.throws(() => apply(t, b, { type: 'layDown', melds: [{ type: 'group', cards: ['H6.1', 'S6.1', 'D6.1'] }] }), /already down/);
});

test('arrange-hand countdown: flips early once everyone is ready; host can flip any time', () => {
  const rng = seeded(3);
  const players = [0, 1, 2].map((i) => ({ id: 'p' + i, name: 'P' + i }));
  const settings = { ...DEFAULT_SETTINGS, decks: 2, composeSeconds: 30, mods: M() };
  let s = apply(newGame(players, settings, { rng }), SYSTEM, { type: 'startRound' }, { rng, now: 0 });
  assert.equal(s.phase, 'compose');
  s = apply(s, 'p0', { type: 'ready' });
  s = apply(s, 'p1', { type: 'ready' });
  s = apply(s, 'p1', { type: 'ready', ready: false });
  assert.deepEqual(viewFor(s, 'p2').ready, ['p0']);
  s = apply(s, 'p1', { type: 'ready' });
  assert.equal(s.phase, 'compose');
  assert.throws(() => apply(s, 'zz', { type: 'ready' }), RuleError);
  s = apply(s, 'p2', { type: 'ready' });
  assert.equal(s.phase, 'turn');
  assert.deepEqual(s.ready, []);
  assert.throws(() => apply(s, 'p0', { type: 'ready' }), /Not now/);
});

test('host can flip early; non-hosts cannot', () => {
  const rng = seeded(4);
  const players = [0, 1].map((i) => ({ id: 'p' + i, name: 'P' + i }));
  const settings = { ...DEFAULT_SETTINGS, decks: 1, composeSeconds: 30, mods: M() };
  let s = apply(newGame(players, settings, { rng }), SYSTEM, { type: 'startRound' }, { rng, now: 0 });
  assert.throws(() => apply(s, 'p1', { type: 'flip' }), RuleError);
  s = apply(s, 'p0', { type: 'flip' }, { isHost: true });
  assert.equal(s.phase, 'turn');
});

test('table cards remember the turn they were played on', () => {
  let { s, rng } = setup(2);
  const a = s.players[s.current].id;
  s.hands[a] = ['H7.0', 'S7.0', 'D7.0', 'H9.0', 'S9.0', 'X1.0', 'C2.0', 'C4.0', 'C6.0', 'D11.0', 'D13.0'];
  s.deck.push('C7.0');
  s = apply(s, a, { type: 'draw', from: 'deck' }, { rng });
  s = apply(s, a, { type: 'layDown', melds: [
    { type: 'group', cards: ['H7.0', 'S7.0', 'D7.0'] },
    { type: 'group', cards: ['H9.0', 'S9.0', 'X1.0'] },
  ] }, { rng });
  const t = s.turnNo;
  const v = viewFor(s, a);
  for (const c of ['H7.0', 'S7.0', 'D7.0', 'H9.0', 'S9.0', 'X1.0']) assert.equal(v.played[c], t);
  s = apply(s, a, { type: 'layOff', meldId: s.melds[0].id, cardId: 'C7.0' }, { rng });
  assert.equal(viewFor(s, a).played['C7.0'], t);
  s.hands[a] = ['C3.0'];
  s = apply(s, a, { type: 'discard', cardId: 'C3.0' }, { rng });
  s = apply(s, SYSTEM, { type: 'startRound' }, { rng, now: 0 });
  assert.deepEqual(viewFor(s, a).played, {}, 'reset each round');
});

// Round 1, one deck, both players down, every Group holds all four of its rank and both Jokers are on the table.
function deadlocked(extraMods = {}) {
  let { s, rng } = setup(2, extraMods);
  const [a, b] = [s.players[s.current].id, s.players[(s.current + 1) % 2].id];
  const all = (r) => ['H', 'S', 'D', 'C'].map((x) => `${x}${r}.0`);
  s.melds = [
    { id: 'm1', owner: a, type: 'group', rank: 8, cards: [...all(8), 'X1.0'] },
    { id: 'm2', owner: a, type: 'group', rank: 13, cards: all(13) },
    { id: 'm3', owner: b, type: 'group', rank: 6, cards: [...all(6), 'X2.0'] },
    { id: 'm4', owner: b, type: 'group', rank: 5, cards: all(5) },
  ];
  s.down = { [a]: { groups: 2, runs: 0 }, [b]: { groups: 2, runs: 0 } };
  const onTable = new Set(s.melds.flatMap((m) => m.cards));
  const loose = buildDeck(1, true).filter((c) => !onTable.has(c));
  s.hands[a] = ['H7.0', 'C3.0', 'D2.0'];
  s.hands[b] = ['S9.0'];
  const held = new Set([...s.hands[a], ...s.hands[b]]);
  const rest = loose.filter((c) => !held.has(c));
  s.discard = [{ id: rest.pop(), by: null, lock: null }];
  s.deck = rest;
  s.lastDiscard = null;
  return { s, rng, a, b };
}

test('stalemate: everyone down and no card left can reach the table ends the round', () => {
  let { s, rng, a, b } = deadlocked();
  s = apply(s, a, { type: 'draw', from: 'deck' }, { rng });
  s = apply(s, a, { type: 'discard', cardId: 'H7.0' }, { rng });
  assert.equal(s.phase, 'roundEnd');
  assert.equal(s.scores[0].out, null);
  assert.ok(s.scores[0].pts[a] > 0 && s.scores[0].pts[b] > 0, 'everyone scores their hand');
  assert.match(s.log.at(-1).text, /Stalemate/);
  s = apply(s, SYSTEM, { type: 'startRound' }, { rng, now: 0 });
  assert.equal(s.round, 1);
});

test('stalemate: not called while a playable card is still in the deck, or a player is not down', () => {
  let { s, rng, a, b } = deadlocked();
  // Free up one 5: it sits in the deck and could still go on the Group of 5s.
  s.melds[3].cards = s.melds[3].cards.filter((c) => c !== 'C5.0');
  s.deck.unshift('C5.0');
  s = apply(s, a, { type: 'draw', from: 'deck' }, { rng });
  s = apply(s, a, { type: 'discard', cardId: 'H7.0' }, { rng });
  assert.equal(s.phase, 'turn');

  ({ s, rng, a, b } = deadlocked());
  delete s.down[b];
  s = apply(s, a, { type: 'draw', from: 'deck' }, { rng });
  s = apply(s, a, { type: 'discard', cardId: 'H7.0' }, { rng });
  assert.equal(s.phase, 'turn', 'a player who is not down can still build melds');
});

test('stalemate: a loose Joker or a swappable Joker with somewhere to go keeps the round alive', () => {
  let { s, rng, a } = deadlocked();
  // Joker back in the deck: it can join the Group of Ks (which has no Joker).
  s.melds[0].cards = s.melds[0].cards.filter((c) => c !== 'X1.0');
  s.deck.unshift('X1.0');
  s = apply(s, a, { type: 'draw', from: 'deck' }, { rng });
  s = apply(s, a, { type: 'discard', cardId: 'H7.0' }, { rng });
  assert.equal(s.phase, 'turn');
});

test('stalemate with Seeing Double: only when no new meld can be built either', () => {
  const req = ROUNDS[0];
  assert.ok(couldStartMeld(['H7.0', 'S7.0', 'D7.0'], req, M()));
  assert.ok(couldStartMeld(['H7.0', 'S7.0', 'X1.0'], req, M()));
  assert.ok(!couldStartMeld(['H7.0', 'S7.0', 'D9.0'], req, M()));
  const runs = ROUNDS[2];
  assert.ok(couldStartMeld(['H2.0', 'H3.0', 'H5.0', 'X1.0'], runs, M()));
  assert.ok(!couldStartMeld(['H13.0', 'H14.0', 'H2.0', 'H3.0'], runs, M()), 'no wrap without Two Ways');
  assert.ok(couldStartMeld(['H13.0', 'H14.0', 'H2.0', 'H3.0'], runs, M({ twoWays: true })));
  assert.ok(couldStartMeld(['H2.0', 'S3.0', 'D4.0', 'C5.0'], runs, M({ crazy: true })));

  // The deadlocked table still has three loose 7s, so with Seeing Double the round goes on.
  let { s, rng, a } = deadlocked({ seeingDouble: true });
  s = apply(s, a, { type: 'draw', from: 'deck' }, { rng });
  s = apply(s, a, { type: 'discard', cardId: 'H7.0' }, { rng });
  assert.equal(s.phase, 'turn');
});

test('a Joker swapped out of a run can go back on an end of the same run', () => {
  let { s, rng } = setup(3);
  const a = s.players[s.current].id;
  s.melds.push({ id: 'mr', owner: a, type: 'run', suit: 'C', start: 5, cards: ['C5.0', 'X1.0', 'C7.0'] });
  s.down[a] = { groups: 2, runs: 0 };
  s = apply(s, a, { type: 'draw', from: 'deck' }, { rng });
  s.hands[a].push('C6.1');
  s = apply(s, a, { type: 'swapJoker', meldId: 'mr', cardId: 'C6.1', target: { meldId: 'mr', end: 'low' } }, { rng });
  const m = s.melds.find((x) => x.id === 'mr');
  assert.deepEqual(m.cards, ['X1.0', 'C5.0', 'C6.1', 'C7.0']);
  assert.equal(m.start, 4);
});
