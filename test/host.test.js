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
