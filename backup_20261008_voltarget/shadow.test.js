// Modo sombra: horarios de NY, RSI(2), abertura/saida com preco do livro e funding, capitulacao, fim de semana, fluxo do fade e momentum.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Shadow, et, RULES } from '../src/shadow.js';
import { OrderBook } from '../src/book.js';
import { BAR } from '../src/util.js';

const H = 3_600_000;
function book(mid, bps = 1) {
  const b = new OrderBook('x');
  const lv = (k) => Array.from({ length: 20 }, (_, i) => ({ price: String(mid * (1 + k * bps * 1e-4 * (i + 1))), size: String(1e9 / mid) }));
  b.apply({ type: 'subscribed/order_book', order_book: { asks: lv(1), bids: lv(-1), nonce: 1 } });
  return b;
}

function make({ syms, cls = () => 'etf_indice', trendRows = [], hourly = {}, liq = 1e6, fades = [], momentum = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-'));
  const books = new Map(syms.map((s) => [s, book(100)]));
  const recorder = { books, markHot() {}, calmCost: () => 0.0001 };
  const bars = { features: () => ({ liq }) };
  const trend = { load: (s) => hourly[s] ?? [], view: () => ({ T: trendRows.T, rows: trendRows.rows ?? [] }) };
  const sh = new Shadow({ dataDir: dir, recorder, bars, live: { lastPx: new Map(), subAt: new Map() }, classOf: cls,
    markets: () => syms.map((s) => ({ symbol: s })), trend, momentum, fades });
  sh.ready = true;
  return { sh, books, dir };
}
const setMid = (books, s, mid) => books.set(s, book(mid));

test('horario de NY e calendario', () => {
  assert.deepEqual(et(Date.parse('2026-10-07T20:00:00Z')), { date: '2026-10-07', wd: 3, hh: 16, mm: 0 }); // EDT
  assert.deepEqual(et(Date.parse('2026-12-07T21:00:00Z')), { date: '2026-12-07', wd: 1, hh: 16, mm: 0 }); // EST
});

test('RSI(2) de Wilder', () => {
  assert.equal(Shadow.rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), 100);
  assert.ok(Shadow.rsi([10, 11, 10, 11, 10, 11, 10, 11, 10, 9, 8]) < 10);
});

test('overnight: compra 16:00 ET, sai no pregao seguinte 9:00 ET (sexta -> segunda), com funding', () => {
  const { sh, books } = make({ syms: RULES.overnight.syms });
  const fri = Date.parse('2026-10-09T20:00:00Z'); // sexta 16:00 EDT
  sh.tick(fri + 6000);
  assert.equal(sh.st.pos.filter((p) => p.strat === 'overnight').length, 6);
  const p = sh.st.pos[0];
  assert.equal(new Date(p.exitAt).toISOString(), '2026-10-12T13:00:00.000Z'); // segunda 9:00 EDT
  sh.tick(fri + 30_000); // mesmo slot: nao abre de novo
  assert.equal(sh.st.pos.filter((p) => p.strat === 'overnight').length, 6);
  sh.onStats('US500', { funding_timestamp: Date.now() + 1000, funding_rate: '0.001', mark_price: '100' }); // long paga 0.001%/h
  for (const s of RULES.overnight.syms) setMid(books, s, 101);
  sh.tick(p.exitAt + 6000);
  const c = sh.st.closed.find((t) => t.sym === 'US500');
  assert.equal(sh.st.pos.length, 0);
  assert.ok(Math.abs(c.bp_mid - (100 - 0.1)) < 1e-6, c.bp_mid);       // +1% - 0.1bp de funding
  assert.ok(c.bp_1k < c.bp_mid && c.bp_1k > c.bp_mid - 3, c.bp_1k);  // paga ~1bp por perna no livro
  assert.equal(c.why, 'tempo');
});

test('overnight nao abre em feriado e evento perdido nao dispara atrasado', () => {
  const { sh } = make({ syms: RULES.overnight.syms });
  sh.tick(Date.parse('2026-11-26T21:00:00Z') + 6000); // Thanksgiving 16:00 EST
  sh.tick(Date.parse('2026-10-07T20:00:00Z') + 11 * 60_000); // 11 min depois da virada
  assert.equal(sh.st.pos.length, 0);
});

test('rsi2: compra com RSI < 10 e vende com RSI > 70', () => {
  // 1h candles que fecham as 16:00 ET de pregoes em queda
  const hourly = { SPY: [] };
  let px = 120;
  for (let d = Date.parse('2026-09-01T19:00:00Z'); d < Date.parse('2026-10-07T00:00:00Z'); d += 86_400_000) {
    const e = et(d + H);
    if (e.wd >= 1 && e.wd <= 5) hourly.SPY.push({ t: d, c: (px -= 1) });
  }
  const { sh, books } = make({ syms: RULES.rsi2.syms, hourly });
  setMid(books, 'SPY', px - 1);
  sh.tick(Date.parse('2026-10-07T20:00:00Z') + 6000);
  assert.ok(sh.st.pos.some((p) => p.strat === 'rsi2' && p.sym === 'SPY'));
  assert.ok(!sh.st.pos.some((p) => p.strat === 'rsi2' && p.sym === 'QQQ')); // sem historico
  hourly.SPY.push({ t: Date.parse('2026-10-07T19:00:00Z'), c: px - 1 }, { t: Date.parse('2026-10-08T19:00:00Z'), c: px + 3 });
  setMid(books, 'SPY', px + 8);
  sh.tick(Date.parse('2026-10-09T20:00:00Z') + 6000);
  const c = sh.st.closed.find((t) => t.strat === 'rsi2');
  assert.ok(c && c.bp_mid > 0 && /RSI/.test(c.why));
});

test('fim de semana: referencia sexta 20:00, abre contra no domingo 20:00, sai segunda 4:00 ET', () => {
  const { sh, books } = make({ syms: ['AAPL', 'MSTR', 'SAMSUNGUSD', 'BTC'], cls: (s) => (s === 'BTC' ? 'cripto' : 'acoes') });
  sh.tick(Date.parse('2026-10-10T00:00:00Z') + 6000); // sexta 20:00 EDT
  assert.deepEqual(Object.keys(sh.st.fdsRef.ref).sort(), ['AAPL', 'MSTR']);
  setMid(books, 'AAPL', 102); setMid(books, 'MSTR', 97);
  sh.tick(Date.parse('2026-10-12T00:00:00Z') + 6000); // domingo 20:00 EDT
  const pos = Object.fromEntries(sh.st.pos.map((p) => [p.sym, p]));
  assert.equal(pos.AAPL.d, -1); assert.equal(pos.MSTR.d, 1);
  assert.equal(new Date(pos.AAPL.exitAt).toISOString(), '2026-10-12T08:00:00.000Z');
});

test('capitulacao: evento com >= 35% dos liquidos <= -80, compra 1h depois, sai 24h depois, intervalo de 3 dias', () => {
  const T = Date.parse('2026-10-07T12:00:00Z');
  const rows = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'].map((s, i) => ({ sym: s, cls: 'cripto', sets: { curto: { score: i < 4 ? -95 + i : 10 } } }));
  const { sh } = make({ syms: rows.map((r) => r.sym), trendRows: { T, rows } });
  sh.onBarClose(T);
  assert.equal(sh.st.cap.pending.basket.length, 5);
  assert.equal(sh.st.cap.pending.basket[0].sym, 'A');
  sh.tick(T + H + 1000);
  assert.equal(sh.st.pos.filter((p) => p.strat === 'capitulacao').length, 5);
  assert.equal(sh.st.pos[0].exitAt, T + 25 * H);
  sh.tick(T + 25 * H + 1000);
  assert.equal(sh.st.closed.filter((t) => t.strat === 'capitulacao').length, 5);
  sh.trend.view = () => ({ T: T + 24 * H, rows });
  sh.onBarClose(T + 24 * H); // 1 dia depois: ainda dentro do intervalo
  assert.equal(sh.st.cap.pending, null);
});

test('fade x fluxo: fracao comprada a mercado na barra do sinal', async () => {
  const k = Date.parse('2026-10-07T12:00:00Z');
  const fade = { name: 'fade', st: { signals: [{ k, sym: 'AAPL', side: 'short', cls: 'acoes', decision: 'setup' }], closed: [] } };
  const { sh } = make({ syms: ['AAPL'], fades: [fade] });
  sh.live.subAt.set('AAPL', k - BAR);
  sh.onTrade('AAPL', { timestamp: k + 1000, usd_amount: '600', is_maker_ask: true });
  sh.onTrade('AAPL', { timestamp: k + 2000, usd_amount: '400', is_maker_ask: false });
  sh.onTrade('AAPL', { timestamp: k - 1000, usd_amount: '999', is_maker_ask: true }); // barra anterior
  await sh.onFadeScan(k);
  assert.equal(sh.st.tbf.length, 1);
  assert.equal(sh.st.tbf[0].tbfL, 0.6);
  assert.equal(sh.st.tbf[0].complete, true);
  await sh.onFadeScan(k); // nao duplica
  assert.equal(sh.st.tbf.length, 1);
  fade.st.closed.push({ signal_bar: k, sym: 'AAPL', R_real: -1 });
  const v = sh.view();
  assert.equal(v.tbf.lighter.nHi, 1); assert.equal(v.tbf.lighter.RHi, -1);
});

test('fade x momentum (H4): lado do momentum no ativo do sinal', async () => {
  const k = Date.parse('2026-10-07T12:00:00Z');
  const sig = (sym) => ({ k, sym, side: 'short', cls: 'acoes', decision: 'setup' });
  const fade = { name: 'fade', st: { signals: [sig('AAA'), sig('BBB'), sig('CCC')], closed: [] } };
  const momentum = { st: { theo: { hold: { AAA: 0.1, BBB: -0.1 } } }, scheduledT: (t) => t };
  const { sh } = make({ syms: ['AAA', 'BBB', 'CCC'], fades: [fade], momentum });
  await sh.onFadeScan(k);
  const by = Object.fromEntries(sh.st.tbf.map((r) => [r.sym, r.mom]));
  assert.deepEqual(by, { AAA: 1, BBB: -1, CCC: 0 });
  fade.st.closed.push({ signal_bar: k, sym: 'AAA', R_real: 1.5 }, { signal_bar: k, sym: 'BBB', R_real: -1 }, { signal_bar: k, sym: 'CCC', R_real: 0.5 });
  const f = sh.view().fadeMom;
  assert.equal(f.g.oposto.n, 1); assert.equal(f.g.oposto.R, 1.5);
  assert.equal(f.g.mesmo.R, -1); assert.equal(f.g.fora.R, 0.5);
  assert.equal(f.sumBase, 1); assert.equal(f.sumVar, 1.75);
  assert.equal(sh.view().tbf.rows.find((r) => r.sym === 'AAA').rel, 'oposto');
});

test('momentum sem esticados: troca a perna esticada pelo proximo do ranking', () => {
  const k = Date.parse('2026-10-07T23:45:00Z');
  // chave = r/vol; X e o mais forte mas subiu 20% em 3 dias com vol diaria 2% (limite 1,5*0,02*sqrt3 = 5,2%)
  const F = { X: [5, 0.2], A: [4, 0.01], B: [3, 0.01], C: [2, 0.01], D: [1, 0.01], E: [-1, -0.01], G: [-2, -0.01], I: [-3, -0.01], J: [-4, -0.01] };
  const momentum = {
    cfg: { perSide: 3, holdDays: 7 },
    target: () => {
      const elig = Object.fromEntries(Object.entries(F).map(([s, [key, r3]]) => [s, { key, c: 100 * (1 + r3), vol: 0.02 }]));
      const o = Object.keys(F).sort((a, b) => F[a][0] - F[b][0]);
      return { elig, long: o.slice(-3), short: o.slice(0, 3), w: {} };
    },
    bars: { bar: (s, t) => (t === k - 3 * 96 * BAR ? { c: 100 } : null) },
  };
  const { sh } = make({ syms: Object.keys(F), momentum });
  const x = sh.momTargets(k, Object.keys(F));
  assert.deepEqual(x.excl, ['X']);
  assert.deepEqual(x.long, ['A', 'B', 'C']);
  assert.deepEqual(x.short, ['J', 'I', 'G']);
});
