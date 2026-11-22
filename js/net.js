// Transports. The host side exposes connection events; the client side is a single pipe.
//
//  Host:   { onConnect(fn(cid)), onMessage(fn(cid,msg)), onDisconnect(fn(cid)), send(cid,msg), close() }
//  Client: { send(msg), onMessage(fn(msg)), onStatus(fn(status, detail)), close() }
//
// PeerJS uses its free public broker only to introduce browsers; game traffic then flows
// over a direct WebRTC data channel (or PeerJS's TURN relay if a direct path isn't possible).

const PREFIX = 'shanghai-rummy-v1-';
const PING_MS = 4000;
const DEAD_MS = 15000;

function emitter() {
  const fns = {};
  return {
    on: (k, f) => ((fns[k] ||= []).push(f)),
    emit: (k, ...a) => (fns[k] || []).forEach((f) => f(...a)),
  };
}

/** Keeps a channel alive and closes it if the other side goes silent. */
function heartbeat(sendPing, onDead) {
  let last = Date.now();
  const timer = setInterval(() => {
    if (Date.now() - last > DEAD_MS) { clearInterval(timer); onDead(); return; }
    sendPing();
  }, PING_MS);
  return { seen: () => (last = Date.now()), stop: () => clearInterval(timer) };
}

// ---------------------------------------------------------------- PeerJS

export function peerHost(code, { onStatus } = {}) {
  const ev = emitter();
  const conns = new Map();
  let peer;
  let closed = false;
  let cidSeq = 0;

  const start = () => {
    // Every handler is bound to this particular Peer object (`p`); events from a Peer we've
    // already replaced are ignored.
    const p = new window.Peer(PREFIX + code);
    peer = p;
    const stale = () => closed || p !== peer;
    p.on('open', () => !stale() && onStatus?.('ready'));
    p.on('connection', (conn) => {
      const cid = 'c' + ++cidSeq;
      let hb;
      const drop = () => {
        if (!conns.has(cid)) return;
        conns.delete(cid);
        hb?.stop();
        try { conn.close(); } catch {}
        ev.emit('disconnect', cid);
      };
      conn.on('open', () => {
        conns.set(cid, conn);
        hb = heartbeat(() => safeSend(conn, { t: 'ping' }), drop);
        ev.emit('connect', cid);
      });
      conn.on('data', (d) => {
        hb?.seen();
        if (d && d.t === 'ping') return;
        ev.emit('message', cid, d);
      });
      conn.on('close', drop);
      conn.on('error', drop);
    });
    p.on('disconnected', () => {
      // PeerJS also fires this just before an 'unavailable-id' error, so decide a moment later.
      setTimeout(() => {
        if (stale() || p.destroyed || !p.disconnected) return;
        onStatus?.('reconnecting');
        p.reconnect();
      }, 1500);
    });
    p.on('error', (err) => {
      if (stale()) return;
      if (err.type === 'unavailable-id') {
        // Someone holds our game code: our own previous session (before a reload) that hasn't
        // expired yet, or a player who took over hosting. Keep trying; the app probes which.
        onStatus?.('claiming');
        p.destroy();
        setTimeout(() => !closed && start(), 1500);
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        onStatus?.('reconnecting', err.type);
      } else if (err.type !== 'peer-unavailable') {
        onStatus?.('error', err.message || err.type);
      }
    });
  };
  start();

  return {
    onConnect: (f) => ev.on('connect', f),
    onMessage: (f) => ev.on('message', f),
    onDisconnect: (f) => ev.on('disconnect', f),
    send: (cid, msg) => { const c = conns.get(cid); if (c) safeSend(c, msg); },
    close: () => { closed = true; peer?.destroy(); },
  };
}

export function peerClient(code) {
  const ev = emitter();
  let peer = null;
  let conn = null;
  let hb = null;
  let closed = false;
  let retryTimer = null;
  let openTimer = null;

  const retry = (ms) => {
    if (closed) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, ms);
  };

  const connect = () => {
    if (closed) return;
    if (!peer || peer.destroyed) {
      const p = new window.Peer();
      peer = p;
      const stale = () => closed || p !== peer;
      p.on('open', () => !stale() && connect());
      p.on('disconnected', () => setTimeout(() => !stale() && !p.destroyed && p.disconnected && p.reconnect(), 1500));
      p.on('error', (err) => {
        if (stale()) return;
        if (err.type === 'peer-unavailable') {
          ev.emit('status', 'nohost');
          retry(3000);
        } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
          ev.emit('status', 'connecting');
          retry(3000);
        }
      });
      return;
    }
    if (!peer.open) return; // wait for 'open'
    if (conn && conn.open) return; // already connected (e.g. broker reconnect re-fired 'open')
    ev.emit('status', 'connecting');
    const c = peer.connect(PREFIX + code, { reliable: true });
    conn = c;
    clearTimeout(openTimer);
    openTimer = setTimeout(() => { if (conn === c && !c.open) { try { c.close(); } catch {} retry(500); } }, 12000);
    c.on('open', () => {
      clearTimeout(openTimer);
      hb = heartbeat(() => safeSend(c, { t: 'ping' }), () => { try { c.close(); } catch {} lost(c); });
      ev.emit('status', 'connected');
    });
    c.on('data', (d) => {
      hb?.seen();
      if (d && d.t === 'ping') return;
      ev.emit('message', d);
    });
    c.on('close', () => lost(c));
    c.on('error', () => lost(c));
  };

  const lost = (c) => {
    if (conn !== c) return;
    conn = null;
    hb?.stop();
    if (closed) return;
    ev.emit('status', 'connecting');
    retry(2000);
  };

  connect();
  return {
    send: (msg) => conn?.open && safeSend(conn, msg),
    onMessage: (f) => ev.on('message', f),
    onStatus: (f) => ev.on('status', f),
    close: () => { closed = true; clearTimeout(retryTimer); hb?.stop(); peer?.destroy(); },
  };
}

function safeSend(conn, msg) {
  try { conn.send(msg); } catch {}
}

// ------------------------------------------------- BroadcastChannel (same browser, for testing)

export function localHost(code, { onStatus } = {}) {
  const ev = emitter();
  const bc = new BroadcastChannel(PREFIX + code);
  const conns = new Set();
  bc.onmessage = ({ data: m }) => {
    if (m.to !== 'host') return;
    if (m.kind === 'connect') { conns.add(m.from); ev.emit('connect', m.from); }
    else if (m.kind === 'close') { conns.delete(m.from); ev.emit('disconnect', m.from); }
    else if (m.kind === 'msg' && conns.has(m.from)) ev.emit('message', m.from, m.data);
  };
  bc.postMessage({ to: '*', kind: 'hostUp' });
  setTimeout(() => onStatus?.('ready'), 0);
  return {
    onConnect: (f) => ev.on('connect', f),
    onMessage: (f) => ev.on('message', f),
    onDisconnect: (f) => ev.on('disconnect', f),
    send: (cid, data) => conns.has(cid) && bc.postMessage({ to: cid, kind: 'msg', data }),
    close: () => bc.close(),
  };
}

export function localClient(code) {
  const ev = emitter();
  const bc = new BroadcastChannel(PREFIX + code);
  const me = 'l' + Math.random().toString(36).slice(2, 10);
  bc.onmessage = ({ data: m }) => {
    if (m.kind === 'hostUp') { bc.postMessage({ to: 'host', from: me, kind: 'connect' }); ev.emit('status', 'connected'); }
    if (m.to === me && m.kind === 'msg') ev.emit('message', m.data);
  };
  setTimeout(() => {
    bc.postMessage({ to: 'host', from: me, kind: 'connect' });
    ev.emit('status', 'connected');
  }, 0);
  addEventListener('beforeunload', () => bc.postMessage({ to: 'host', from: me, kind: 'close' }));
  return {
    send: (data) => bc.postMessage({ to: 'host', from: me, kind: 'msg', data }),
    onMessage: (f) => ev.on('message', f),
    onStatus: (f) => ev.on('status', f),
    close: () => { bc.postMessage({ to: 'host', from: me, kind: 'close' }); bc.close(); },
  };
}
