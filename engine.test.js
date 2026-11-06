'use strict';
const assert = require('assert');
const { Table, shuffle, newDeck, score5, bestScore, handName, buildPots, parseCard } = require('../poker');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.log(`FAIL  ${name}\n      ${e.stack}`); process.exitCode = 1; }
}
const C = (s) => s.split(' ').map(parseCard);

// ------------------------------------------------------------ avaliação

test('ranking das categorias em ordem crescente', () => {
  const hands = [
    '2c 4d 6h 8s Jc',   // carta alta
    '2c 2d 6h 8s Jc',   // par
    '2c 2d 6h 6s Jc',   // dois pares
    '2c 2d 2h 8s Jc',   // trinca
    '4c 5d 6h 7s 8c',   // sequência
    '2c 4c 6c 8c Jc',   // flush
    '2c 2d 2h 8s 8c',   // full house
    '2c 2d 2h 2s 8c',   // quadra
    '4c 5c 6c 7c 8c',   // straight flush
  ].map((h) => score5(C(h)));
  for (let i = 1; i < hands.length; i++) assert(hands[i] > hands[i - 1], `categoria ${i}`);
});

test('wheel (A-2-3-4-5) perde para sequência de 6', () => {
  assert(score5(C('Ac 2d 3h 4s 5c')) < score5(C('2c 3d 4h 5s 6c')));
  assert.strictEqual(handName(score5(C('Ac 2d 3h 4s 5c'))), 'Sequência');
});

test('royal flush é identificado', () => {
  assert.strictEqual(handName(score5(C('Ac Kc Qc Jc Tc'))), 'Royal flush');
  assert.strictEqual(handName(score5(C('9c Kc Qc Jc Tc'))), 'Straight flush');
});

test('kickers desempatam', () => {
  assert(score5(C('Ac Ad Kh 5s 2c')) > score5(C('Ac Ad Qh 5s 2c')));
  assert(score5(C('Ac Ad Kh Ks 2c')) > score5(C('Ac Ad Qh Qs Kc')));
});

test('melhor mão de 7 cartas', () => {
  const s = bestScore(C('Ah Kh Qh Jh 2c 3d Th'));
  assert.strictEqual(handName(s), 'Royal flush');
  const s2 = bestScore(C('2c 2d 2h 9s 9c 3d 4h'));
  assert.strictEqual(handName(s2), 'Full house');
});

test('mesma mão em naipes diferentes empata', () => {
  assert.strictEqual(bestScore(C('Ah Kd 2c 7s 9h 4d 3c')), bestScore(C('Ad Kc 2h 7d 9s 4c 3h')));
});

// ------------------------------------------------------------ potes

test('buildPots: all-ins de tamanhos diferentes', () => {
  const pots = buildPots([
    { id: 0, total: 100, folded: false },
    { id: 1, total: 300, folded: false },
    { id: 2, total: 1000, folded: false },
  ]);
  assert.deepStrictEqual(pots, [
    { amount: 300, eligible: [0, 1, 2] },
    { amount: 400, eligible: [1, 2] },
    { amount: 700, eligible: [2] },
  ]);
});

test('buildPots: quem desistiu paga mas não concorre', () => {
  const pots = buildPots([
    { id: 0, total: 50, folded: true },
    { id: 1, total: 200, folded: false },
    { id: 2, total: 200, folded: false },
  ]);
  assert.strictEqual(pots.reduce((a, p) => a + p.amount, 0), 450);
  assert.deepStrictEqual(pots.map((p) => p.eligible), [[1, 2]]);
});

// ------------------------------------------------------------ embaralhamento

test('embaralhamento gera permutação válida', () => {
  const d = shuffle(newDeck());
  assert.strictEqual(d.length, 52);
  assert.deepStrictEqual([...d].sort((a, b) => a - b), newDeck());
});

test('embaralhamento é uniforme (primeira carta, qui-quadrado frouxo)', () => {
  const N = 52000;
  const counts = new Array(52).fill(0);
  for (let i = 0; i < N; i++) counts[shuffle(newDeck())[0]]++;
  const exp = N / 52;
  const chi = counts.reduce((a, c) => a + (c - exp) ** 2 / exp, 0);
  assert(chi < 90, `chi² = ${chi.toFixed(1)} (esperado ~51, limite 90)`); // 51 gl, p≈0.001
});

// ------------------------------------------------------------ fluxo da mão

function mkTable(n, stacks) {
  const t = new Table();
  for (let i = 0; i < n; i++) t.addPlayer(`p${i}`, `J${i}`);
  if (stacks) stacks.forEach((s, i) => { t.seats[i].stack = s; });
  return t;
}

test('3 jogadores: dealer, blinds e primeiro a agir', () => {
  const t = mkTable(3);
  t.startHand();
  assert.strictEqual(t.dealer, 0);
  assert.strictEqual(t.seats[1].bet, 10);
  assert.strictEqual(t.seats[2].bet, 20);
  assert.strictEqual(t.toAct, 0); // UTG = dealer em mesa de 3
});

test('heads-up: dealer é o small blind e age primeiro no pré-flop', () => {
  const t = mkTable(2);
  t.startHand();
  assert.strictEqual(t.seats[t.dealer].bet, 10);
  assert.strictEqual(t.toAct, t.dealer);
  t.act(`p${t.dealer}`, 'call');
  // BB tem a opção de dar check
  assert.strictEqual(t.phase, 'preflop');
  const bb = t.toAct;
  assert.notStrictEqual(bb, t.dealer);
  t.act(`p${bb}`, 'check');
  assert.strictEqual(t.phase, 'flop');
  assert.strictEqual(t.toAct, bb); // pós-flop o BB age primeiro
});

test('todos desistem: big blind ganha os blinds', () => {
  const t = mkTable(3);
  t.startHand();
  t.act('p0', 'fold');
  t.act('p1', 'fold');
  assert.strictEqual(t.phase, 'showdown');
  assert.strictEqual(t.seats[2].stack, 1010);
  assert.strictEqual(t.seats[1].stack, 990);
  assert.strictEqual(t.seats[0].stack, 1000);
});

test('regras de aumento mínimo e vez de jogar', () => {
  const t = mkTable(3);
  t.startHand();
  assert.throws(() => t.act('p1', 'call'), /vez/);
  assert.throws(() => t.act('p0', 'raise', 30), /mínimo/);
  assert.throws(() => t.act('p0', 'check'), /pagar/);
  t.act('p0', 'raise', 60);
  assert.strictEqual(t.currentBet, 60);
  assert.throws(() => t.act('p1', 'raise', 90), /mínimo/); // mínimo agora é 100
  t.act('p1', 'raise', 100);
});

test('side pots: 3 all-ins com stacks 100 / 300 / 1000', () => {
  const t = mkTable(3, [100, 300, 1000]);
  t.startHand();
  t.seats[0].hole = C('Ah As');
  t.seats[1].hole = C('Kh Ks');
  t.seats[2].hole = C('2c 7d');
  t.deck = C('Qd 8c 3s 4h 9c');
  t.act('p0', 'allin');
  t.act('p1', 'allin');
  t.act('p2', 'allin');
  assert.strictEqual(t.phase, 'showdown');
  assert.strictEqual(t.seats[0].stack, 300);   // pote principal
  assert.strictEqual(t.seats[1].stack, 400);   // pote lateral
  assert.strictEqual(t.seats[2].stack, 700);   // aposta não paga devolvida
  assert.strictEqual(t.board.length, 5);
});

test('empate divide o pote (e o resto vai a quem está à esquerda do dealer)', () => {
  const t = mkTable(2, [101, 101]);
  t.startHand();
  const [a, b] = [t.seats[0], t.seats[1]];
  a.hole = C('Ah Kd'); b.hole = C('As Kc');
  t.deck = C('2c 7d 9h Js 3c');
  t.act(`p${t.toAct}`, 'allin');
  t.act(`p${t.toAct}`, 'allin');
  assert.strictEqual(t.phase, 'showdown');
  assert.strictEqual(a.stack + b.stack, 202);
  assert.strictEqual(a.stack, 101);
});

test('mão não é revelada quando todos desistem; é revelada no showdown', () => {
  const t = mkTable(3);
  t.startHand();
  const v0 = t.view('p0');
  assert.strictEqual(v0.seats[0].cards.length, 2);
  assert.notStrictEqual(v0.seats[0].cards[0], 'xx');
  assert.deepStrictEqual(v0.seats[1].cards, ['xx', 'xx']);
  assert(!JSON.stringify(v0).includes('p1'), 'view vaza id de outro jogador');
  t.act('p0', 'fold'); t.act('p1', 'fold');
  assert.deepStrictEqual(t.view('p0').seats[2].cards, ['xx', 'xx']); // vencedor não mostra
  assert.strictEqual(t.view('p0').result.showdown, false);
});

test('jogador que sai no meio da mão é dobrado e removido no fim', () => {
  const t = mkTable(3);
  t.startHand();
  t.removePlayer('p0');
  assert.strictEqual(t.toAct, 1);
  t.act('p1', 'fold');
  assert.strictEqual(t.phase, 'showdown');
  assert.strictEqual(t.seats[0], null);
});

test('rebuy só para quem está sem fichas e fora de mão em andamento', () => {
  const t = mkTable(3);
  assert.throws(() => t.rebuy('p0'), /ainda tem fichas/);
  t.seats[0].stack = 0;
  t.rebuy('p0');
  assert.strictEqual(t.seats[0].stack, 1000);
  assert.strictEqual(t.seats[0].rebuys, 1);
});

test('desconectado não é sentado na próxima mão', () => {
  const t = mkTable(3);
  t.setConnected('p2', false);
  t.startHand();
  assert.strictEqual(t.seats[2].inHand, false);
  assert.strictEqual(t.seats[2].hole.length, 0);
});

// ------------------------------------------------------------ simulação

test('simulação: 600 mãos com 5 bots aleatórios conservam todas as fichas', () => {
  const t = mkTable(5);
  let injected = 5 * 1000;
  let hands = 0;
  let guard = 0;
  while (hands < 600) {
    if (++guard > 200000) throw new Error('loop infinito');
    if (t.phase === 'waiting' || t.phase === 'showdown') {
      for (let i = 0; i < 5; i++) {
        if (t.seats[i].stack === 0) { t.rebuy(`p${i}`); injected += 1000; }
      }
      t.startHand();
      hands++;
      continue;
    }
    const id = `p${t.toAct}`;
    const v = t.view(id).you.legal;
    const r = Math.random();
    if (r < 0.15) t.act(id, 'fold');
    else if (r < 0.65) t.act(id, v.canCheck ? 'check' : 'call');
    else if (r < 0.90 && v.canRaise) {
      const amt = v.minRaiseTo + Math.floor(Math.random() * (v.maxRaiseTo - v.minRaiseTo + 1));
      t.act(id, 'raise', amt);
    } else if (v.canRaise) t.act(id, 'allin');
    else t.act(id, v.canCheck ? 'check' : 'call');

    // em jogo: stacks + apostado = total injetado; mão encerrada: só stacks
    const total = t.seats.reduce((a, s) => a + s.stack + (t._inPlay() ? s.totalBet : 0), 0);
    assert.strictEqual(total, injected, `fichas fora do lugar na mão ${hands}`);
    t.seats.forEach((s) => assert(s.stack >= 0 && Number.isInteger(s.stack)));
  }
  assert.strictEqual(t.seats.reduce((a, s) => a + s.stack + (t._inPlay() ? s.totalBet : 0), 0), injected);
});

console.log(`\n${passed} testes passaram${process.exitCode ? ' (com falhas)' : ''}`);
