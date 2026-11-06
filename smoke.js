'use strict';
// Smoke test de ponta a ponta: sobe o servidor, conecta 3 clientes WebSocket e joga mãos até o showdown.
const { spawn } = require('child_process');
const WebSocket = require('ws');
const assert = require('assert');

const PORT = 3999;
const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT }, stdio: 'inherit' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name) {
  const c = { name, token: null, state: null, room: null, errors: [], ws: new WebSocket(`ws://localhost:${PORT}`) };
  c.ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'joined') { c.token = m.token; c.room = m.room; }
    if (m.type === 'state') c.state = m.state;
    if (m.type === 'error') c.errors.push(m.message);
  });
  c.open = new Promise((r) => c.ws.on('open', r));
  c.send = (o) => c.ws.send(JSON.stringify(o));
  return c;
}

(async () => {
  try {
    await sleep(600);
    const res = await fetch(`http://localhost:${PORT}/`);
    assert.strictEqual(res.status, 200);
    assert((await res.text()).includes('Naypes'));

    const [a, b, c] = ['Ana', 'Beto', 'Caio'].map(client);
    await Promise.all([a.open, b.open, c.open]);
    a.send({ type: 'join', name: 'Ana' });
    await sleep(200);
    assert(a.room, 'sala criada');
    b.send({ type: 'join', room: a.room, name: 'Beto' });
    c.send({ type: 'join', room: a.room.toLowerCase(), name: 'Caio' });
    await sleep(300);
    assert.strictEqual(a.state.seats.filter(Boolean).length, 3);
    assert.strictEqual(a.state.canStart, true);

    // cliente inexistente
    const d = client('X'); await d.open; d.send({ type: 'join', room: 'ZZZZZ', name: 'X' }); await sleep(200);
    assert(d.errors.some((e) => /não encontrada/.test(e)));

    a.send({ type: 'start' });
    await sleep(300);
    assert.strictEqual(a.state.phase, 'preflop');

    // ninguém vê cartas dos outros
    for (const p of [a, b, c]) {
      const mine = p.state.seats[p.state.you.seat].cards;
      assert(mine.every((x) => x !== 'xx'));
      p.state.seats.filter((s) => s && !s.isYou).forEach((s) => assert.deepStrictEqual(s.cards, ['xx', 'xx']));
      assert(!JSON.stringify(p.state).includes(p.token));
    }

    // jogar até o fim da mão: todos pagam/dão check
    const all = [a, b, c];
    for (let i = 0; i < 40 && all[0].state.phase !== 'showdown'; i++) {
      const p = all.find((x) => x.state.you.legal);
      if (!p) { await sleep(100); continue; }
      p.send({ type: 'act', action: p.state.you.legal.canCheck ? 'check' : 'call' });
      await sleep(120);
    }
    assert.strictEqual(a.state.phase, 'showdown');
    assert(a.state.result && a.state.result.showdown);
    assert.strictEqual(a.state.board.length, 5);
    const sum = a.state.seats.filter(Boolean).reduce((x, s) => x + s.stack, 0);
    assert.strictEqual(sum, 3000);

    // reconexão com o mesmo token mantém o assento
    const seatBefore = b.state.you.seat;
    b.ws.close();
    await sleep(200);
    const b2 = client('Beto'); await b2.open;
    b2.send({ type: 'join', room: a.room, token: b.token, name: 'Beto' });
    await sleep(300);
    assert.strictEqual(b2.state.you.seat, seatBefore);
    assert.strictEqual(a.state.seats.filter(Boolean).length, 3, 'não duplicou assento');

    // act fora da vez gera erro de regra
    a.errors.length = 0;
    a.send({ type: 'act', action: 'check' }); await sleep(150);
    assert(a.errors.length >= 1 || a.state.you.legal, 'erro fora de hora');

    console.log('smoke ok');
  } catch (e) {
    console.error('SMOKE FAIL', e);
    process.exitCode = 1;
  } finally {
    srv.kill();
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  }
})();
