'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Table } = require('./poker');

const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, 'public', 'index.html');

const NEXT_HAND_MS = { showdown: 7000, uncontested: 3500 };
const DISCONNECTED_ACT_MS = 15000;
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;

/** @type {Map<string, {code:string, table:Table, conns:Map<string,any>, timers:{next:any, auto:any}, lastActive:number}>} */
const rooms = new Map();

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 5; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}

function createRoom() {
  const code = newCode();
  const room = { code, table: new Table(), conns: new Map(), timers: { next: null, auto: null }, lastActive: Date.now() };
  rooms.set(code, room);
  return room;
}

// ------------------------------------------------------------ HTTP

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (pathname === '/') {
    fs.readFile(INDEX, (err, buf) => {
      if (err) { res.writeHead(500); return res.end('index.html não encontrado'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
    return undefined;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  return res.end('Não encontrado');
});

// ------------------------------------------------------------ WebSocket

const wss = new WebSocketServer({ server, maxPayload: 2048 });

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(room) {
  for (const [token, ws] of room.conns) send(ws, { type: 'state', room: room.code, state: room.table.view(token) });
}

function afterChange(room) {
  const t = room.table;
  room.lastActive = Date.now();
  const anyoneConnected = room.conns.size > 0;

  // fim de mão → agenda a próxima automaticamente
  if (t.phase === 'showdown' && !room.timers.next) {
    const delay = t.result && t.result.showdown ? NEXT_HAND_MS.showdown : NEXT_HAND_MS.uncontested;
    room.timers.next = setTimeout(() => {
      room.timers.next = null;
      if (room.conns.size === 0) { if (t.phase === 'showdown') t.phase = 'waiting'; return; }
      t.nextHandOrWait();
      afterChange(room);
    }, delay);
  }

  // vez de um jogador desconectado → ação automática depois de um tempo
  clearTimeout(room.timers.auto);
  room.timers.auto = null;
  if (anyoneConnected && ['preflop', 'flop', 'turn', 'river'].includes(t.phase) && t.toAct >= 0) {
    const s = t.seats[t.toAct];
    if (s && !s.connected) {
      room.timers.auto = setTimeout(() => {
        room.timers.auto = null;
        try { t.autoAct(s.id); } catch { /* mão pode ter mudado */ }
        afterChange(room);
      }, DISCONNECTED_ACT_MS);
    }
  }
  broadcast(room);
}

function detach(ws) {
  const { room, token } = ws.ctx || {};
  if (!room) return;
  if (room.conns.get(token) === ws) room.conns.delete(token);
  room.table.setConnected(token, false);
  afterChange(room);
}

function cleanName(n) {
  return String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16) || 'Jogador';
}

function handle(ws, msg) {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'join') {
    let room;
    if (!msg.room) room = createRoom();
    else {
      room = rooms.get(String(msg.room).toUpperCase().trim());
      if (!room) return send(ws, { type: 'error', code: 'no_room', message: 'Sala não encontrada. Confira o código.' });
    }
    let token = typeof msg.token === 'string' ? msg.token : null;
    if (!(token && room.table.seatOf(token) >= 0)) {
      token = crypto.randomBytes(16).toString('hex');
      try { room.table.addPlayer(token, cleanName(msg.name)); }
      catch (e) { return send(ws, { type: 'error', code: 'full', message: e.message }); }
    }
    const old = room.conns.get(token);
    if (old && old !== ws) { old.ctx = {}; old.close(); }
    room.conns.set(token, ws);
    ws.ctx = { room, token };
    room.table.setConnected(token, true);
    send(ws, { type: 'joined', room: room.code, token });
    return afterChange(room);
  }

  const { room, token } = ws.ctx || {};
  if (!room) return send(ws, { type: 'error', code: 'not_joined', message: 'Entre em uma sala primeiro' });
  const t = room.table;

  try {
    switch (msg.type) {
      case 'start':
        if (t.phase !== 'waiting') throw new Error('A partida já está em andamento');
        t.startHand();
        break;
      case 'act':
        t.act(token, String(msg.action), msg.amount);
        break;
      case 'rebuy':
        t.rebuy(token);
        break;
      case 'leave':
        t.removePlayer(token);
        room.conns.delete(token);
        ws.ctx = {};
        send(ws, { type: 'left' });
        break;
      default:
        return undefined;
    }
  } catch (e) {
    return send(ws, { type: 'error', code: 'rule', message: e.message });
  }
  return afterChange(room);
}

wss.on('connection', (ws) => {
  ws.ctx = {};
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    handle(ws, msg);
  });
  ws.on('close', () => detach(ws));
  ws.on('error', () => {});
});

// heartbeat: derruba conexões mortas (celular que perdeu sinal) para a mesa não travar
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 20000);

// limpa salas abandonadas
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.conns.size === 0 && now - room.lastActive > ROOM_TTL_MS) {
      clearTimeout(room.timers.next);
      clearTimeout(room.timers.auto);
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000);

server.listen(PORT, () => console.log(`Naypes rodando na porta ${PORT}`));
