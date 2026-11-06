'use strict';
/**
 * Naypes — motor de Texas Hold'em (sem I/O, sem dependências).
 * Toda a lógica vive aqui; o servidor só repassa mensagens.
 *
 * Cartas são inteiros 0..51: rank = (c % 13) + 2  (2..14, 14 = Ás), naipe = floor(c / 13).
 */
const crypto = require('crypto');

const RANK_CH = '23456789TJQKA';
const SUIT_CH = 'shdc';
const B = 15; // base para codificar o score da mão

const cardRank = (c) => (c % 13) + 2;
const cardSuit = (c) => Math.floor(c / 13);
const cardStr = (c) => RANK_CH[cardRank(c) - 2] + SUIT_CH[cardSuit(c)];
const parseCard = (s) => SUIT_CH.indexOf(s[1]) * 13 + RANK_CH.indexOf(s[0]);

const newDeck = () => Array.from({ length: 52 }, (_, i) => i);

/** Fisher-Yates com aleatoriedade criptográfica (crypto.randomInt é sem viés). */
function shuffle(arr, randInt = (n) => crypto.randomInt(n)) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------- avaliação

const HAND_NAMES = ['Carta alta', 'Par', 'Dois pares', 'Trinca', 'Sequência', 'Flush', 'Full house', 'Quadra', 'Straight flush'];

/** Score numérico de 5 cartas: maior score = mão melhor. */
function score5(cs) {
  const ranks = cs.map(cardRank).sort((a, b) => b - a);
  const flush = cs.every((c) => cardSuit(c) === cardSuit(cs[0]));
  const counts = new Map();
  for (const r of ranks) counts.set(r, (counts.get(r) || 0) + 1);
  const groups = [...counts.entries()].map(([r, n]) => ({ r, n })).sort((a, b) => b.n - a.n || b.r - a.r);

  let straightHigh = 0;
  if (groups.length === 5) {
    if (ranks[0] - ranks[4] === 4) straightHigh = ranks[0];
    else if (ranks[0] === 14 && ranks[1] === 5) straightHigh = 5; // A-2-3-4-5
  }

  let cat;
  let ks;
  if (straightHigh && flush) { cat = 8; ks = [straightHigh]; }
  else if (groups[0].n === 4) { cat = 7; ks = groups.map((g) => g.r); }
  else if (groups[0].n === 3 && groups[1].n === 2) { cat = 6; ks = groups.map((g) => g.r); }
  else if (flush) { cat = 5; ks = ranks; }
  else if (straightHigh) { cat = 4; ks = [straightHigh]; }
  else if (groups[0].n === 3) { cat = 3; ks = groups.map((g) => g.r); }
  else if (groups[0].n === 2 && groups[1].n === 2) { cat = 2; ks = groups.map((g) => g.r); }
  else if (groups[0].n === 2) { cat = 1; ks = groups.map((g) => g.r); }
  else { cat = 0; ks = ranks; }

  let s = cat;
  for (let i = 0; i < 5; i++) s = s * B + (ks[i] || 0);
  return s;
}

/** Melhor mão de 5 entre 5 a 7 cartas. */
function bestScore(cards) {
  let best = -1;
  const chosen = [];
  (function rec(start) {
    if (chosen.length === 5) {
      const s = score5(chosen);
      if (s > best) best = s;
      return;
    }
    for (let i = start; i < cards.length; i++) {
      chosen.push(cards[i]);
      rec(i + 1);
      chosen.pop();
    }
  })(0);
  return best;
}

function handName(score) {
  const cat = Math.floor(score / B ** 5);
  if (cat === 8 && Math.floor(score / B ** 4) % B === 14) return 'Royal flush';
  return HAND_NAMES[cat];
}

// ---------------------------------------------------------------- potes

/**
 * Constrói pote principal + laterais a partir do total que cada jogador colocou.
 * contribs: [{ id, total, folded }]  →  [{ amount, eligible: [id...] }]
 * Apostas não pagas viram um pote com um só elegível (ele recebe de volta).
 */
function buildPots(contribs) {
  const levels = [...new Set(contribs.filter((c) => c.total > 0).map((c) => c.total))].sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  for (const lvl of levels) {
    let amount = 0;
    for (const c of contribs) amount += Math.max(0, Math.min(c.total, lvl) - prev);
    const eligible = contribs.filter((c) => !c.folded && c.total >= lvl).map((c) => c.id);
    prev = lvl;
    if (eligible.length === 0) {
      if (pots.length) pots[pots.length - 1].amount += amount;
      continue;
    }
    const last = pots[pots.length - 1];
    if (last && last.eligible.length === eligible.length && last.eligible.every((id, k) => id === eligible[k])) {
      last.amount += amount; // mesmo grupo de elegíveis: junta
    } else {
      pots.push({ amount, eligible });
    }
  }
  return pots;
}

// ---------------------------------------------------------------- mesa

const PLAYING = ['preflop', 'flop', 'turn', 'river'];

class Table {
  constructor(opts = {}) {
    this.maxSeats = 5;
    this.startingStack = opts.startingStack ?? 1000;
    this.sb = opts.smallBlind ?? 10;
    this.bb = opts.bigBlind ?? 20;
    this.rand = opts.randInt || ((n) => crypto.randomInt(n));
    this.makeDeck = opts.makeDeck || (() => shuffle(newDeck(), this.rand));

    this.seats = new Array(this.maxSeats).fill(null);
    this.phase = 'waiting'; // waiting | preflop | flop | turn | river | showdown
    this.board = [];
    this.deck = [];
    this.dealer = -1;
    this.currentBet = 0;
    this.lastRaise = this.bb;
    this.toAct = -1;
    this.handNumber = 0;
    this.result = null;
    this.log = [];
  }

  // ------------------------------------------------------------ assentos

  seatOf(id) {
    return this.seats.findIndex((s) => s && s.id === id);
  }

  addPlayer(id, name) {
    if (this.seatOf(id) >= 0) throw new Error('Você já está na mesa');
    const i = this.seats.findIndex((s) => !s);
    if (i < 0) throw new Error('Mesa cheia (máximo de 5 jogadores)');
    const clean = String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16) || 'Jogador';
    this.seats[i] = {
      id, name: clean, stack: this.startingStack, rebuys: 0,
      bet: 0, totalBet: 0, folded: false, allIn: false, hole: [],
      acted: false, raiseLocked: false, inHand: false, shown: false,
      connected: true, leaving: false,
    };
    this._log(`${clean} sentou à mesa`);
    return i;
  }

  setConnected(id, connected) {
    const i = this.seatOf(id);
    if (i >= 0) this.seats[i].connected = connected;
  }

  removePlayer(id) {
    const i = this.seatOf(id);
    if (i < 0) return;
    const s = this.seats[i];
    this._log(`${s.name} saiu da mesa`);
    if (s.inHand && this._inPlay()) {
      s.leaving = true;
      if (!s.folded) {
        s.folded = true;
        this._afterAction({ keep: this.toAct !== i });
      }
    } else {
      this.seats[i] = null;
    }
  }

  rebuy(id) {
    const i = this.seatOf(id);
    if (i < 0) throw new Error('Você não está na mesa');
    const s = this.seats[i];
    if (s.stack > 0) throw new Error('Você ainda tem fichas');
    if (s.inHand && this._inPlay()) throw new Error('Aguarde o fim da mão');
    s.stack = this.startingStack;
    s.rebuys += 1;
    this._log(`${s.name} pegou mais ${this.startingStack} fichas`);
  }

  // ------------------------------------------------------------ início de mão

  canStart() {
    return (this.phase === 'waiting' || this.phase === 'showdown') &&
      this.seats.filter((s) => s && s.stack > 0 && !s.leaving && s.connected !== false).length >= 2;
  }

  /** Após o showdown: começa a próxima mão ou volta a esperar jogadores. */
  nextHandOrWait() {
    if (this.canStart()) this.startHand();
    else if (this.phase === 'showdown') this.phase = 'waiting';
  }

  startHand() {
    if (!this.canStart()) throw new Error('Precisa de pelo menos 2 jogadores com fichas');
    const inHand = [];
    this.seats.forEach((s, i) => {
      if (!s) return;
      Object.assign(s, { bet: 0, totalBet: 0, folded: false, allIn: false, hole: [], acted: false, raiseLocked: false, shown: false, inHand: false });
      if (s.stack > 0 && !s.leaving && s.connected !== false) { s.inHand = true; inHand.push(i); }
      else s.folded = true;
    });

    this.handNumber += 1;
    this.result = null;
    this.board = [];
    this.deck = this.makeDeck();
    this.dealer = this._next(this.dealer, (s) => s.inHand);

    const headsUp = inHand.length === 2;
    const sbI = headsUp ? this.dealer : this._next(this.dealer, (s) => s.inHand);
    const bbI = this._next(sbI, (s) => s.inHand);
    this._post(sbI, this.sb);
    this._post(bbI, this.bb);
    this.currentBet = Math.max(this.seats[sbI].bet, this.seats[bbI].bet);
    this.lastRaise = this.bb;

    // distribui 2 cartas a cada um, começando à esquerda do dealer
    const order = [];
    let k = this.dealer;
    for (let n = 0; n < inHand.length; n++) { k = this._next(k, (s) => s.inHand); order.push(k); }
    for (let r = 0; r < 2; r++) for (const i of order) this.seats[i].hole.push(this.deck.shift());

    this.phase = 'preflop';
    this._log(`Mão #${this.handNumber}: blinds ${this.sb}/${this.bb}`);
    this.toAct = bbI; // "último a agir": _afterAction avança para o próximo
    this._afterAction();
  }

  // ------------------------------------------------------------ ações

  act(id, action, amount) {
    const i = this.seatOf(id);
    if (i < 0) throw new Error('Você não está na mesa');
    if (!this._inPlay()) throw new Error('Não há mão em andamento');
    if (i !== this.toAct) throw new Error('Não é a sua vez');
    const s = this.seats[i];
    const toCall = this.currentBet - s.bet;

    if (action === 'allin') {
      const total = s.bet + s.stack;
      action = total <= this.currentBet ? 'call' : 'raise';
      amount = total;
    }

    switch (action) {
      case 'fold':
        s.folded = true;
        this._log(`${s.name} desistiu`);
        break;

      case 'check':
        if (toCall > 0) throw new Error('Há aposta a pagar: pague ou desista');
        s.acted = true;
        this._log(`${s.name} deu check`);
        break;

      case 'call': {
        if (toCall <= 0) throw new Error('Não há o que pagar: dê check');
        const paid = this._commit(s, Math.min(toCall, s.stack));
        s.acted = true;
        this._log(`${s.name} pagou ${paid}${s.allIn ? ' (all-in)' : ''}`);
        break;
      }

      case 'raise': {
        amount = Math.floor(Number(amount));
        if (!Number.isFinite(amount)) throw new Error('Valor inválido');
        const maxTo = s.bet + s.stack;
        if (amount > maxTo) throw new Error('Fichas insuficientes');
        if (amount <= this.currentBet) {
          if (amount === maxTo && toCall > 0) return this.act(id, 'call');
          throw new Error('O valor precisa ser maior que a aposta atual');
        }
        if (s.raiseLocked) throw new Error('A aposta não foi reaberta: você só pode pagar ou desistir');
        const minTo = this.currentBet + this.lastRaise;
        if (amount < minTo && amount !== maxTo) throw new Error(`Aumento mínimo: ${minTo}`);

        const wasBet = this.currentBet === 0;
        const raiseSize = amount - this.currentBet;
        this._commit(s, amount - s.bet);
        if (raiseSize >= this.lastRaise) {
          // aumento completo: reabre a ação para todos
          this.lastRaise = raiseSize;
          this.seats.forEach((o, j) => {
            if (o && j !== i && o.inHand && !o.folded && !o.allIn) { o.acted = false; o.raiseLocked = false; }
          });
        } else {
          // all-in curto: quem já agiu só pode pagar ou desistir
          this.seats.forEach((o, j) => {
            if (o && j !== i && o.inHand && !o.folded && !o.allIn && o.acted) o.raiseLocked = true;
          });
        }
        this.currentBet = amount;
        s.acted = true;
        this._log(`${s.name} ${wasBet ? 'apostou' : 'aumentou para'} ${amount}${s.allIn ? ' (all-in)' : ''}`);
        break;
      }

      default:
        throw new Error('Ação desconhecida');
    }
    this._afterAction();
  }

  /** Para jogador desconectado: check se der, senão fold. */
  autoAct(id) {
    const i = this.seatOf(id);
    if (i < 0 || i !== this.toAct || !this._inPlay()) return;
    this.act(id, this.currentBet - this.seats[i].bet <= 0 ? 'check' : 'fold');
  }

  // ------------------------------------------------------------ internos

  _inPlay() { return PLAYING.includes(this.phase); }

  _log(msg) {
    this.log.push(msg);
    if (this.log.length > 50) this.log.shift();
  }

  /** Próximo assento (depois de `from`) que satisfaz pred. */
  _next(from, pred) {
    const n = this.maxSeats;
    for (let k = 1; k <= n; k++) {
      const idx = (((from + k) % n) + n) % n;
      const s = this.seats[idx];
      if (s && pred(s)) return idx;
    }
    return -1;
  }

  _liveIdx() {
    const out = [];
    this.seats.forEach((s, i) => { if (s && s.inHand && !s.folded) out.push(i); });
    return out;
  }

  _commit(s, amt) {
    amt = Math.min(amt, s.stack);
    s.stack -= amt;
    s.bet += amt;
    s.totalBet += amt;
    if (s.stack === 0) s.allIn = true;
    return amt;
  }

  _post(i, amt) {
    const s = this.seats[i];
    this._commit(s, amt);
  }

  _afterAction(opts = {}) {
    const live = this._liveIdx();
    if (live.length === 1) return this._finishUncontested(live[0]);

    const actors = live.filter((i) => !this.seats[i].allIn);
    let pending = [];
    const settled = actors.every((i) => this.seats[i].bet >= this.currentBet);
    if (!(actors.length <= 1 && settled)) {
      pending = actors.filter((i) => !this.seats[i].acted || this.seats[i].bet < this.currentBet);
    }
    if (pending.length === 0) return this._endStreet();

    if (!(opts.keep && pending.includes(this.toAct))) {
      this.toAct = this._next(this.toAct, (s) => {
        const idx = this.seats.indexOf(s);
        return pending.includes(idx);
      });
    }
    return undefined;
  }

  _endStreet() {
    for (const s of this.seats) if (s) { s.bet = 0; s.acted = false; s.raiseLocked = false; }
    this.currentBet = 0;
    this.lastRaise = this.bb;
    for (;;) {
      if (this.phase === 'river') return this._showdown();
      if (this.phase === 'preflop') { this.phase = 'flop'; for (let k = 0; k < 3; k++) this.board.push(this.deck.shift()); }
      else if (this.phase === 'flop') { this.phase = 'turn'; this.board.push(this.deck.shift()); }
      else if (this.phase === 'turn') { this.phase = 'river'; this.board.push(this.deck.shift()); }
      const actors = this._liveIdx().filter((i) => !this.seats[i].allIn);
      if (actors.length >= 2) {
        this.toAct = this._next(this.dealer, (s) => s.inHand && !s.folded && !s.allIn);
        return undefined;
      }
    }
  }

  _dist(i) { return (((i - this.dealer - 1) % this.maxSeats) + this.maxSeats) % this.maxSeats; }

  _finishUncontested(wi) {
    const w = this.seats[wi];
    const total = this.seats.reduce((a, s) => a + (s ? s.totalBet : 0), 0);
    w.stack += total;
    this.result = {
      showdown: false, board: this.board.map(cardStr), players: [],
      pots: [{ amount: total, hand: null, returned: false, winners: [{ seat: wi, name: w.name, won: total }] }],
    };
    this._log(`${w.name} ganhou ${total}`);
    this._finishHand();
  }

  _showdown() {
    const liveI = this._liveIdx();
    const players = [];
    for (const i of liveI) {
      const s = this.seats[i];
      s.shown = true;
      s.score = bestScore([...s.hole, ...this.board]);
      players.push({ seat: i, name: s.name, hole: s.hole.map(cardStr), hand: handName(s.score) });
    }
    const contribs = [];
    this.seats.forEach((s, i) => { if (s && s.inHand) contribs.push({ id: i, total: s.totalBet, folded: s.folded }); });

    const potsOut = [];
    for (const pot of buildPots(contribs)) {
      if (pot.eligible.length === 1) {
        const i = pot.eligible[0];
        this.seats[i].stack += pot.amount;
        potsOut.push({ amount: pot.amount, hand: null, returned: true, winners: [{ seat: i, name: this.seats[i].name, won: pot.amount }] });
        continue;
      }
      let best = -1;
      for (const i of pot.eligible) best = Math.max(best, this.seats[i].score);
      const winners = pot.eligible.filter((i) => this.seats[i].score === best).sort((a, b) => this._dist(a) - this._dist(b));
      const share = Math.floor(pot.amount / winners.length);
      const rem = pot.amount - share * winners.length;
      const wOut = winners.map((i, k) => {
        const won = share + (k < rem ? 1 : 0);
        this.seats[i].stack += won;
        return { seat: i, name: this.seats[i].name, won };
      });
      potsOut.push({ amount: pot.amount, hand: handName(best), returned: false, winners: wOut });
    }
    this.result = { showdown: true, board: this.board.map(cardStr), players, pots: potsOut };
    for (const p of potsOut) {
      if (!p.returned) this._log(`${p.winners.map((w) => w.name).join(' e ')} ganhou ${p.amount} com ${p.hand}`);
    }
    this._finishHand();
  }

  _finishHand() {
    this.phase = 'showdown';
    this.toAct = -1;
    this.seats.forEach((s, i) => { if (s && s.leaving) this.seats[i] = null; });
  }

  // ------------------------------------------------------------ visão por jogador

  /** Estado que um jogador pode ver: nunca inclui cartas ocultas nem ids de outros. */
  view(id) {
    const me = this.seatOf(id);
    const playing = this._inPlay();
    const pot = this.seats.reduce((a, s) => a + (s ? s.totalBet : 0), 0);

    const seats = this.seats.map((s, i) => {
      if (!s) return null;
      let cards = [];
      if (i === me) cards = s.hole.map(cardStr);
      else if (s.shown) cards = s.hole.map(cardStr);
      else if (s.inHand && !s.folded && s.hole.length) cards = ['xx', 'xx'];
      return {
        index: i, name: s.name, stack: s.stack, bet: s.bet, rebuys: s.rebuys,
        folded: s.folded && s.inHand, allIn: s.allIn && s.inHand,
        inHand: s.inHand, connected: s.connected, isYou: i === me, isDealer: i === this.dealer && s.inHand,
        isTurn: playing && i === this.toAct, cards,
        busted: s.stack === 0 && !(playing && s.inHand),
      };
    });

    let you = null;
    if (me >= 0) {
      const s = this.seats[me];
      you = { seat: me, legal: null, canRebuy: s.stack === 0 && !(s.inHand && playing) };
      if (playing && this.toAct === me) {
        const toCall = Math.max(0, this.currentBet - s.bet);
        const maxTo = s.bet + s.stack;
        you.legal = {
          canCheck: toCall === 0,
          toCall: Math.min(toCall, s.stack),
          canRaise: !s.raiseLocked && maxTo > this.currentBet,
          isBet: this.currentBet === 0,
          minRaiseTo: Math.min(this.currentBet + this.lastRaise, maxTo),
          maxRaiseTo: maxTo,
        };
      }
    }

    return {
      phase: this.phase, handNumber: this.handNumber, board: this.board.map(cardStr), pot,
      currentBet: this.currentBet, dealer: this.dealer, toAct: playing ? this.toAct : -1,
      blinds: { sb: this.sb, bb: this.bb }, seats, you,
      result: playing ? null : this.result, log: this.log.slice(-8), canStart: this.canStart(),
    };
  }
}

module.exports = { Table, shuffle, newDeck, score5, bestScore, handName, buildPots, cardStr, parseCard };
