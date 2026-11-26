import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostSession } from '../js/host.js';

function fakeTransport() {
  const h = { connect: [], message: [], disconnect: [] };
  const outbox = {};
  return {
    onConnect: (f) => h.connect.push(f),
    onMessage: (f) => h.message.push(f),
    onDisconnect: (f) => h.disconnect.push(f),
    send: (cid, msg) => (outbox[cid] ||= []).push(msg),
    close() {},
    // test helpers
    deliver: (cid, msg) => h.message.forEach((f) => f(cid, msg)),
    drop: (cid) => h.disconnect.forEach((f) => f(cid)),
    last: (cid, t) => (outbox[cid] || []).filter((m) => m.t === t).at(-1),
  };
}

test('lobby join, start, act over the wire, reconnect, reject late joiners', () => {
  const tr = fakeTransport();
  let saved = null;
  const s = new HostSession({ code: 'ABCDE', host: { id: 'H', name: 'Hostess' }, transport: tr, save: (d) => (saved = d) });
  s.updateSettings({ composeSeconds: 0 });
  tr.deliver('c1', { t: 'hello', pid: 'P1', name: '  Bob  ' });
  tr.deliver('c2', { t: 'hello', pid: 'P2', name: '<b>Cy</b>' });
  assert.equal(tr.last('c1', 'view').v.lobby.players.length, 3);
  assert.equal(tr.last('c1', 'view').v.lobby.players[1].name, 'Bob');

  assert.equal(s.startGame(), null);
  assert.equal(s.act('H', { type: 'startRound' }), null);
  const v1 = tr.last('c1', 'view').v.game;
  assert.equal(v1.phase, 'turn');
  assert.equal(v1.hand.length, 11);
  // Other players' hands are never sent
  assert.ok(!JSON.stringify(tr.last('c1', 'view')).includes(JSON.stringify(saved.game.hands.P2)));

  // Non-host cannot start a round
  tr.deliver('c1', { t: 'act', a: { type: 'startRound' }, rid: 'x' });
  assert.equal(tr.last('c1', 'err').msg, 'Only the host can do that');

  // Whoever's turn it is draws via the wire (or locally for host)
  const cur = v1.players[v1.current].id;
  if (cur === 'H') assert.equal(s.act('H', { type: 'draw', from: 'deck' }), null);
  else tr.deliver(cur === 'P1' ? 'c1' : 'c2', { t: 'act', a: { type: 'draw', from: 'deck' } });
  assert.equal(saved.game.turnStep, 'play');

  // Disconnect and reconnect P1 on a new connection
  tr.drop('c1');
  assert.equal(s.viewFor('H').online.P1, false);
  tr.deliver('c9', { t: 'hello', pid: 'P1', name: 'Bob' });
  assert.equal(s.viewFor('H').online.P1, true);
  assert.equal(tr.last('c9', 'view').v.game.hand.length, saved.game.hands.P1.length);

  // Stranger can't join mid-game
  tr.deliver('c5', { t: 'hello', pid: 'P5', name: 'Late' });
  assert.match(tr.last('c5', 'reject').reason, /already started/);

  // Restore from saved data (host reload)
  const tr2 = fakeTransport();
  const s2 = new HostSession({ code: 'ABCDE', host: { id: 'H', name: 'Hostess' }, transport: tr2, restore: structuredClone(saved) });
  assert.equal(s2.viewFor('H').game.turnStep, 'play');
  s.close();
  s2.close();
});

test('host can drop a player mid-game; they cannot rejoin', () => {
  const tr = fakeTransport();
  let saved = null;
  const s = new HostSession({ code: 'ABCDE', host: { id: 'H', name: 'H' }, transport: tr, save: (d) => (saved = d) });
  s.updateSettings({ composeSeconds: 0 });
  tr.deliver('c1', { t: 'hello', pid: 'P1', name: 'A' });
  tr.deliver('c2', { t: 'hello', pid: 'P2', name: 'B' });
  s.startGame();
  s.act('H', { type: 'startRound' });
  const deck = saved.game.deck.length;
  assert.equal(s.dropPlayer('H'), "You can't remove yourself");
  assert.equal(s.dropPlayer('P1'), null);
  assert.equal(saved.game.players.length, 2);
  assert.equal(saved.game.deck.length, deck + 11);
  assert.match(tr.last('c1', 'reject').reason, /removed you/);
  tr.deliver('c3', { t: 'hello', pid: 'P1', name: 'A' });
  assert.match(tr.last('c3', 'reject').reason, /removed you/);
  assert.equal(tr.last('c2', 'view').v.game.departed[0].name, 'A');
  s.endGame();
  assert.deepEqual(s.viewFor('H').lobby.players.map((p) => p.id), ['H', 'P2']);
  s.close();
});

test('takeover: new host rebuilds from reported hands, old host is refused', () => {
  const tr = fakeTransport();
  let saved = null;
  const s = new HostSession({ code: 'ABCDE', host: { id: 'H', name: 'Hal' }, transport: tr, save: (d) => (saved = d) });
  s.updateSettings({ composeSeconds: 0 });
  tr.deliver('c1', { t: 'hello', pid: 'P1', name: 'Bo' });
  tr.deliver('c2', { t: 'hello', pid: 'P2', name: 'Cy' });
  s.startGame();
  s.act('H', { type: 'startRound' });
  const lastP1 = tr.last('c1', 'view').v;
  const lastP2 = tr.last('c2', 'view').v;
  s.close(); // host vanishes

  // P1 takes over using its last view
  const tr2 = fakeTransport();
  const n = new HostSession({ code: 'ABCDE', host: { id: 'P1', name: 'Bo' }, transport: tr2, recovery: { view: lastP1 }, save: (d) => (saved = d) });
  assert.equal(n.viewFor('P1').recovering.waitingFor[0].id, 'P2');
  tr2.deliver('x', { t: 'hello', pid: 'H', name: 'Hal' });
  assert.match(tr2.last('x', 'reject').reason, /took over/);
  tr2.deliver('c2', { t: 'hello', pid: 'P2', name: 'Cy', resume: { snap: lastP2.snapshot, hand: lastP2.game.hand } });
  const v = tr2.last('c2', 'view').v;
  assert.equal(v.recovering, undefined);
  assert.deepEqual(v.game.hand, lastP2.game.hand);
  assert.deepEqual(v.game.players.map((p) => p.id), ['P1', 'P2']);
  assert.equal(v.game.departed[0].id, 'H');
  assert.equal(saved.hostId, 'P1');
  n.close();
});

test('voluntary handoff: full data goes to the new host; old host rejoins as a player', () => {
  const tr = fakeTransport();
  const s = new HostSession({ code: 'ABCDE', host: { id: 'H', name: 'Hal' }, transport: tr });
  s.updateSettings({ composeSeconds: 0 });
  tr.deliver('c1', { t: 'hello', pid: 'P1', name: 'Bo' });
  tr.deliver('c2', { t: 'hello', pid: 'P2', name: 'Cy' });
  s.startGame();
  s.act('H', { type: 'startRound' });
  let handed = null;
  s.onHandedOff = (pid) => (handed = pid);
  assert.equal(s.handOff('P1'), null);
  assert.match(s.act('H', { type: 'draw', from: 'deck' }), /host is changing/);
  assert.match(tr.last('c2', 'notice').msg, /Bo/);
  const data = tr.last('c1', 'becomeHost').data;
  tr.deliver('c1', { t: 'hostAck' });
  assert.equal(handed, 'P1');
  s.close();
  const tr2 = fakeTransport();
  const n = new HostSession({ code: 'ABCDE', host: { id: 'P1', name: 'Bo' }, transport: tr2, restore: data });
  tr2.deliver('h', { t: 'hello', pid: 'H', name: 'Hal' });
  const hv = tr2.last('h', 'view').v;
  assert.equal(hv.hostId, 'P1');
  assert.equal(hv.game.hand.length, 11, 'old host keeps their hand');
  assert.equal(n.act('H', { type: 'startRound' }), 'Only the host can do that');
  n.close();
});

test('players vote for modifiers in the lobby; the host sees who wants what', () => {
  const tr = fakeTransport();
  const s = new HostSession({ code: 'ABCDE', host: { id: 'H', name: 'Hostess' }, transport: tr });
  tr.deliver('c1', { t: 'hello', pid: 'P1', name: 'Bob' });
  tr.deliver('c2', { t: 'hello', pid: 'P2', name: 'Cy' });
  tr.deliver('c1', { t: 'vote', mod: 'crazy', on: true });
  tr.deliver('c2', { t: 'vote', mod: 'crazy', on: true });
  tr.deliver('c2', { t: 'vote', mod: 'gambit', on: true });
  tr.deliver('c2', { t: 'vote', mod: 'nonsense', on: true });
  assert.deepEqual(s.viewFor('H').lobby.votes, { crazy: ['P1', 'P2'], gambit: ['P2'] });
  assert.deepEqual(tr.last('c1', 'view').v.lobby.votes.crazy, ['P1', 'P2']);
  // Voting doesn't change the settings; only the host does that
  assert.equal(s.viewFor('H').lobby.settings.mods.crazy, false);

  tr.deliver('c1', { t: 'vote', mod: 'crazy', on: false });
  tr.deliver('c1', { t: 'vote', mod: 'crazy', on: false });
  assert.deepEqual(s.viewFor('H').lobby.votes.crazy, ['P2']);

  // Leaving or being removed takes your votes with you
  s.kick('P2');
  assert.deepEqual(s.viewFor('H').lobby.votes, {});

  // No voting once the game is on
  tr.deliver('c1', { t: 'vote', mod: 'twoWays', on: true });
  tr.deliver('c3', { t: 'hello', pid: 'P3', name: 'Di' });
  s.startGame();
  tr.deliver('c3', { t: 'vote', mod: 'crazy', on: true });
  assert.deepEqual(s.viewFor('H').lobby.votes, { twoWays: ['P1'] });

  // Saves from before voting existed still load
  const old = new HostSession({ code: 'ABCDE', host: { id: 'H', name: 'H' }, transport: fakeTransport(),
    restore: { code: 'ABCDE', hostId: 'H', lobby: { players: [{ id: 'H', name: 'H' }], settings: s.data.lobby.settings }, game: null } });
  assert.deepEqual(old.viewFor('H').lobby.votes, {});
  s.close();
});

test('chat and reactions are relayed to everyone, checked, and kept short', () => {
  const tr = fakeTransport();
  let t = 1000;
  const s = new HostSession({ code: 'ABCDE', host: { id: 'H', name: 'H' }, transport: tr, now: () => t });
  tr.deliver('c1', { t: 'hello', pid: 'P1', name: 'Ann' });
  tr.deliver('c2', { t: 'hello', pid: 'P2', name: 'Bo' });

  tr.deliver('c1', { t: 'chat', text: '  hi\n  <b>all</b>  ' });
  assert.equal(s.chat('H', { emoji: '😂' }), null);
  const chat = tr.last('c2', 'view').v.chat;
  assert.deepEqual(chat.map(({ n, from, name, text, emoji }) => ({ n, from, name, text, emoji })), [
    { n: 1, from: 'P1', name: 'Ann', text: 'hi <b>all</b>', emoji: undefined },
    { n: 2, from: 'H', name: 'H', text: undefined, emoji: '😂' },
  ]);

  // Unknown reactions, blank messages and strangers are refused
  tr.deliver('c2', { t: 'chat', emoji: '💩' });
  assert.equal(tr.last('c2', 'err').msg, 'Unknown reaction');
  assert.equal(s.chat('P2', { text: '   ' }), null);
  assert.equal(s.chat('nobody', { text: 'hey' }), 'Chat is unavailable right now');
  assert.equal(s.viewFor('H').chat.length, 2);

  // Long messages are cut; bursts are throttled
  s.chat('P2', { text: 'x'.repeat(500) });
  assert.equal(s.viewFor('H').chat.at(-1).text.length, 200);
  for (let i = 0; i < 5; i++) s.chat('P2', { emoji: '👍' });
  assert.equal(s.chat('P2', { emoji: '👍' }), 'Slow down a little');
  t += 6000;
  assert.equal(s.chat('P2', { emoji: '👍' }), null);

  // Only the most recent messages are kept, and numbering carries on
  for (let i = 0; i < 100; i++) { t += 2000; s.chat('H', { text: `m${i}` }); }
  const kept = s.viewFor('P1').chat;
  assert.equal(kept.length, 60);
  assert.equal(kept.at(-1).text, 'm99');
  assert.equal(kept.at(-1).n, kept[0].n + 59);
  s.close();
});
