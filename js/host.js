// Host session: owns the lobby + authoritative game state, talks to remote players
// over a transport, and drives timers (compose countdown, buy window).
// DOM-free so it can be exercised from tests.

import {
  newGame, apply, viewFor, SYSTEM, DEFAULT_SETTINGS, RuleError, settingsProblem, suggestedDecks,
  publicSnapshot, rebuildFromSnapshot, BUY_WINDOW_MS,
} from './engine.js';

export const MAX_PLAYERS = 10;

const cleanName = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 20) || 'Player';

export class HostSession {
  /**
   * @param {object} o
   * @param {string} o.code
   * @param {{id:string,name:string}} o.host
   * @param {object} o.transport host transport (see net.js)
   * @param {(data)=>void} [o.save] persist callback
   * @param {object} [o.restore] previously saved data (host reload, or a voluntary handoff)
   * @param {object} [o.recovery] {view}: take over a game whose host vanished, from our last view of it
   */
  constructor({ code, host, transport, save, restore, recovery, now = () => Date.now() }) {
    this.code = code;
    this.hostId = host.id;
    this.transport = transport;
    this.saveFn = save;
    this.now = now;
    this.listeners = [];
    this.connToPid = new Map();
    this.pidToConn = new Map();
    this.timer = null;
    this.recovery = null;
    this.handoff = null;
    this.onHandedOff = null;
    if (recovery) {
      const v = recovery.view;
      const oldHostId = v.hostId;
      const players = v.lobby.players.map(({ id, name }) => ({ id, name }));
      this.data = { code, hostId: host.id, lobby: { players, settings: v.lobby.settings }, game: null };
      if (v.snapshot) {
        const oldHostName = [...v.snapshot.players, ...(v.snapshot.departed || [])].find((p) => p.id === oldHostId)?.name || 'The host';
        this.recovery = { oldHostId, oldHostName, best: v.snapshot, reports: { [host.id]: v.game?.hand || [] } };
      } else {
        // Lobby only: nothing secret to rebuild.
        this.data.lobby.players = players.filter((p) => p.id !== oldHostId);
      }
    } else {
      this.data = restore || {
        code,
        hostId: host.id,
        lobby: { players: [{ id: host.id, name: cleanName(host.name) }], settings: structuredClone(DEFAULT_SETTINGS) },
        game: null,
      };
    }
    this.data.hostId = host.id;
    if (this.recovery && this.recovery.best.players.every((p) => p.id === this.recovery.oldHostId || p.id in this.recovery.reports)) {
      this.finishRecovery(); // nobody else to wait for
    }
    transport.onConnect(() => {});
    transport.onMessage((cid, msg) => this.onMessage(cid, msg));
    transport.onDisconnect((cid) => {
      const pid = this.connToPid.get(cid);
      this.connToPid.delete(cid);
      if (pid && this.pidToConn.get(pid) === cid) this.pidToConn.delete(pid);
      this.changed(false);
    });
    this.schedule();
  }

  // ---- outward

  onUpdate(fn) { this.listeners.push(fn); fn(this.viewFor(this.hostId)); }

  online(pid) { return pid === this.hostId || this.pidToConn.has(pid); }

  viewFor(pid) {
    const { lobby, game } = this.data;
    if (this.recovery) {
      const r = this.recovery;
      const waiting = r.best.players.filter((p) => p.id !== r.oldHostId && !(p.id in r.reports));
      return {
        code: this.code, hostId: this.hostId, me: pid, now: this.now(),
        lobby: { players: [], settings: lobby.settings },
        online: Object.fromEntries(r.best.players.map((p) => [p.id, this.online(p.id)])),
        game: null,
        recovering: { from: r.oldHostName, host: r.best.players.find((p) => p.id === this.hostId)?.name, waitingFor: waiting.map((p) => ({ id: p.id, name: p.name, online: this.online(p.id) })) },
      };
    }
    return {
      code: this.code,
      hostId: this.hostId,
      me: pid,
      now: this.now(), // lets clients correct for clock skew on countdowns
      lobby: {
        players: lobby.players.map((p) => ({ ...p, online: this.online(p.id) })),
        settings: lobby.settings,
      },
      online: Object.fromEntries((game ? game.players : lobby.players).map((p) => [p.id, this.online(p.id)])),
      game: game ? viewFor(game, pid) : null,
      snapshot: game ? publicSnapshot(game) : null,
    };
  }

  changed(persist = true) {
    const { lobby, game } = this.data;
    if (!game && lobby.settings.decksAuto !== false) lobby.settings.decks = suggestedDecks(lobby.players.length).normal;
    if (persist && !this.recovery) this.saveFn?.(this.data);
    for (const [pid, cid] of this.pidToConn) this.transport.send(cid, { t: 'view', v: this.viewFor(pid) });
    const hv = this.viewFor(this.hostId);
    this.listeners.forEach((f) => f(hv));
    this.schedule();
  }

  // ---- inbound

  onMessage(cid, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'hello') return this.hello(cid, msg);
    const pid = this.connToPid.get(cid);
    if (!pid) return;
    if (msg.t === 'hostAck' && this.handoff?.pid === pid) {
      clearTimeout(this.handoff.timer);
      this.onHandedOff?.(pid);
    } else if (msg.t === 'act') {
      const err = this.act(pid, msg.a);
      if (err) this.transport.send(cid, { t: 'err', msg: err, rid: msg.rid });
    } else if (msg.t === 'leave') {
      if (!this.data.game) {
        this.data.lobby.players = this.data.lobby.players.filter((p) => p.id !== pid);
        this.changed();
      }
    }
  }

  hello(cid, { pid, name, resume }) {
    pid = String(pid || '').slice(0, 40);
    if (!pid || pid === this.hostId) return this.transport.send(cid, { t: 'reject', reason: 'Bad player id' });
    if (this.recovery) return this.recoveryHello(cid, pid, resume);
    const { lobby, game } = this.data;
    if (game) {
      if (!game.players.some((p) => p.id === pid)) {
        const removed = (game.departed || []).some((p) => p.id === pid);
        const reason = (this.data.replacedHosts || []).includes(pid)
          ? `While you were away, ${game.players.find((p) => p.id === this.hostId)?.name || 'another player'} took over hosting, so you were removed from the game.`
          : removed ? 'The host removed you from this game.' : 'That game has already started.';
        return this.transport.send(cid, { t: 'reject', reason });
      }
    } else {
      const existing = lobby.players.find((p) => p.id === pid);
      if (existing) existing.name = cleanName(name);
      else if (lobby.players.length >= MAX_PLAYERS) return this.transport.send(cid, { t: 'reject', reason: 'The game is full.' });
      else lobby.players.push({ id: pid, name: cleanName(name) });
    }
    this.register(cid, pid);
    this.changed();
  }

  register(cid, pid) {
    const old = this.pidToConn.get(pid);
    if (old && old !== cid) this.connToPid.delete(old);
    this.connToPid.set(cid, pid);
    this.pidToConn.set(pid, cid);
  }

  // ---- taking over from a host who vanished

  recoveryHello(cid, pid, resume) {
    const r = this.recovery;
    if (pid === r.oldHostId) {
      return this.transport.send(cid, { t: 'reject', reason: 'Someone else took over hosting while you were away, so you were removed from the game.' });
    }
    if (!r.best.players.some((p) => p.id === pid)) {
      return this.transport.send(cid, { t: 'reject', reason: 'That game has already started.' });
    }
    // Use whichever player saw the most recent state (the old host may have died mid-broadcast).
    const snap = resume?.snap;
    if (snap?.players && snap.ver > (r.best.ver || 0)) r.best = snap;
    if (Array.isArray(resume?.hand)) r.reports[pid] = resume.hand.map(String);
    this.register(cid, pid);
    const waiting = r.best.players.filter((p) => p.id !== r.oldHostId && !(p.id in r.reports));
    if (!waiting.length) this.finishRecovery();
    else this.changed(false);
  }

  /** Rebuild the game now. Anyone who hasn't reported their hand is dropped, like the old host. */
  finishRecovery() {
    const r = this.recovery;
    if (!r) return;
    this.recovery = null;
    this.data.game = rebuildFromSnapshot(r.best, r.reports, this.hostId, r.oldHostId);
    this.data.replacedHosts = [...(this.data.replacedHosts || []), r.oldHostId];
    const still = new Set(this.data.game.players.map((p) => p.id));
    this.data.lobby.players = this.data.lobby.players.filter((p) => still.has(p.id));
    for (const [pid, cid] of [...this.pidToConn]) {
      if (still.has(pid)) continue;
      this.transport.send(cid, { t: 'reject', reason: 'You were removed from the game when the host changed.' });
      this.pidToConn.delete(pid);
      this.connToPid.delete(cid);
    }
    this.changed();
  }

  // ---- voluntary handoff

  /** Send the whole game to another connected player, who becomes the host. */
  handOff(pid) {
    const cid = this.pidToConn.get(pid);
    if (!cid) return "That player isn't connected";
    if (this.recovery) return 'Finish rebuilding the game first';
    const name = this.data.lobby.players.find((p) => p.id === pid)?.name
      || this.data.game?.players.find((p) => p.id === pid)?.name || 'them';
    this.handoff = {
      pid,
      timer: setTimeout(() => { this.handoff = null; this.onHandOffFailed?.(name); this.changed(false); }, 15000),
    };
    clearTimeout(this.timer); // freeze timers; the new host reschedules them
    for (const [p, c] of this.pidToConn) {
      if (p !== pid) this.transport.send(c, { t: 'notice', msg: `Handing hosting over to ${name}…` });
    }
    this.transport.send(cid, { t: 'becomeHost', data: structuredClone(this.data) });
    return null;
  }

  /** Apply a game action as `pid`. Returns an error string or null. */
  act(pid, a) {
    const game = this.data.game;
    if (this.handoff) return 'The host is changing — try again in a moment';
    if (!game) return 'The game has not started';
    try {
      this.data.game = apply(game, pid, a, { now: this.now(), isHost: pid === this.hostId });
      this.changed();
      return null;
    } catch (e) {
      if (e instanceof RuleError) return e.message;
      console.error(e);
      return 'Something went wrong';
    }
  }

  // ---- host-only lobby controls

  updateSettings(patch) {
    if (this.data.game) return;
    const s = this.data.lobby.settings;
    Object.assign(s, patch, { mods: { ...s.mods, ...(patch.mods || {}) } });
    this.changed();
  }

  rename(name) {
    const me = this.data.lobby.players.find((p) => p.id === this.hostId);
    if (me) me.name = cleanName(name);
    this.changed();
  }

  movePlayer(pid, dir) {
    const ps = this.data.lobby.players;
    const i = ps.findIndex((p) => p.id === pid);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ps.length) return;
    [ps[i], ps[j]] = [ps[j], ps[i]];
    this.changed();
  }

  /** Remove a player from a game in progress (or the lobby). Returns an error string or null. */
  dropPlayer(pid) {
    if (pid === this.hostId) return "You can't remove yourself";
    if (!this.data.game) { this.kick(pid); return null; }
    const err = this.act(this.hostId, { type: 'dropPlayer', pid });
    if (err) return err;
    this.data.lobby.players = this.data.lobby.players.filter((p) => p.id !== pid);
    const cid = this.pidToConn.get(pid);
    if (cid) {
      this.transport.send(cid, { t: 'reject', reason: 'The host removed you from this game.' });
      this.pidToConn.delete(pid);
      this.connToPid.delete(cid);
    }
    this.changed();
    return null;
  }

  kick(pid) {
    if (pid === this.hostId || this.data.game) return;
    this.data.lobby.players = this.data.lobby.players.filter((p) => p.id !== pid);
    const cid = this.pidToConn.get(pid);
    if (cid) {
      this.transport.send(cid, { t: 'reject', reason: 'The host removed you from the lobby.' });
      this.pidToConn.delete(pid);
      this.connToPid.delete(cid);
    }
    this.changed();
  }

  startGame() {
    const { lobby } = this.data;
    const problem = settingsProblem(lobby.settings, lobby.players.length);
    if (problem) return problem;
    this.data.game = newGame(lobby.players, lobby.settings);
    this.changed();
    return null;
  }

  endGame() {
    this.data.game = null;
    // Players who never reconnected stay listed; host can kick them.
    this.changed();
  }

  // ---- timers

  schedule() {
    clearTimeout(this.timer);
    this.timer = null;
    const g = this.data.game;
    if (!g || this.handoff) return;
    let at = null;
    let action = null;
    let maxWait = 0;
    if (g.phase === 'compose' && g.composeUntil) { at = g.composeUntil; action = { type: 'flip' }; maxWait = (g.settings.composeSeconds + 2) * 1000; }
    else if (g.pendingBuy) { at = g.pendingBuy.until; action = { type: 'resolveBuy' }; maxWait = BUY_WINDOW_MS + 500; }
    if (!action) return;
    // Clamp: deadlines may come from a previous host's clock.
    this.timer = setTimeout(() => {
      try {
        this.data.game = apply(this.data.game, SYSTEM, action, { now: this.now() });
        this.changed();
      } catch (e) {
        if (!(e instanceof RuleError)) console.error(e);
      }
    }, Math.min(maxWait, Math.max(0, at - this.now())));
  }

  close() {
    clearTimeout(this.timer);
    clearTimeout(this.handoff?.timer);
    this.transport.close();
  }
}
