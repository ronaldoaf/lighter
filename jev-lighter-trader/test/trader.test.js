// jev-lighter-trader: ranking por forca 4h·1d·7d, estado enviado ao JEV, abertura/fechamento no livro, funding e contabilidade.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JevTrader } from '../src/trader.js';
import { indicators, to4h } from '../src/indicators.js';
import { TrendBoard } from '../../src/trend.js';
import { OrderBook } from '../../src/book.js';
import { BAR } from '../../src/util.js';

const H = 3_600_000;
function book(mid, bps = 1) {
  const b = new OrderBook('x');
  const lv = (k) => Array.from({ length: 20 }, (_, i) => ({ price: String(mid * (1 + k * bps * 1e-4 * (i + 1))), size: String(1e9 / mid) }));
  b.apply({ type: 'subscribed/order_book', order_book: { asks: lv(1), bids: lv(-1), nonce: 1 } });
  return b;
}
// passeio aleatorio deterministico com deriva (drift por hora)
function series(T, n, step, p0, drift, seed) {
  let s = seed, p = p0;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
  const out = [];
  for (let i = n; i >= 1; i--) {
    const o = p; p *= Math.exp(drift * step / H + 0.004 * rnd());
    out.push({ t: T - i * step, o, h: Math.max(o, p) * 1.001, l: Math.min(o, p) * 0.999, c: p, V: 1e6 });
  }
  return out;
}

function make(client, cfgX = {}) {
  const T = Date.parse('2026-10-07T20:00:00Z');
  const drifts = { UP: 0.004, DN: -0.004, MID: 0.0005, FLAT: 0, BTC: 0.0001 };
  const b15 = {}, b1 = {};
  Object.entries(drifts).forEach(([s, d], i) => { b15[s] = series(T, 900, BAR, 100, d, i + 7); b1[s] = series(T, 1000, H, 100, d, i + 99); });
  const markets = () => Object.keys(drifts).map((symbol) => ({ symbol }));
  const bars = { load: (s) => b15[s] ?? [], lastRefresh: T };
  const trend = new TrendBoard({ rest: null, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'jt-')), classOf: () => 'cripto', markets, bars15: bars });
  for (const s of Object.keys(drifts)) trend.bars.set(s, b1[s]);
  trend.updatedAt = Math.floor(T / H) * H;
  const books = new Map(Object.keys(drifts).map((s) => [s, book(100)]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jv-'));
  const jt = new JevTrader({ cfg: { topN: 3, liqMinUSD: 0, ...cfgX }, dataDir: dir, recorder: { books }, bars, trend, classOf: () => 'cripto', client });
  return { jt, T, books, dir, bars };
}

function fakeClient(pick, prob = () => 0.7) {
  const calls = [];
  return { calls, async decide(state, q) {
    calls.push({ state, q });
    const opts = Object.keys(q.action.criteria), c = pick(state, opts), pc = prob(state, opts);
    return { model: 'fake', answers: { action: { type: 'choice', choice: c, confidence: 0.5, probabilities: Object.fromEntries(opts.map((o) => [o, o === c ? pc : (1 - pc) / (opts.length - 1)])) } }, usage: { input_tokens: 1000 } };
  } };
}

test('indicadores: valores coerentes e agregacao 4h so com blocos completos', () => {
  const T = Date.parse('2026-10-07T20:00:00Z');
  const up = series(T, 300, BAR, 100, 0.01, 3);
  const i = indicators(up, '15-minute', 96, '24h');
  assert.ok(i.rsi14.value > 60 && i.dist_ema50_pct.value > 0 && i.adx14.value > 0, JSON.stringify(i.rsi14));
  assert.ok(i.range_pos.value >= 0 && i.range_pos.value <= 1);
  const h1 = series(T + 2 * H, 50, H, 100, 0, 5); // ultimas 2 horas formam bloco incompleto ate T
  const b4 = to4h(h1, T);
  assert.equal(b4.at(-1).t + 4 * H, T);
  assert.ok(b4.every((x) => x.t % (4 * H) === 0));
  const blk = h1.filter((x) => x.t >= b4.at(-1).t && x.t < T);
  assert.equal(b4.at(-1).c, blk.at(-1).c);
  assert.equal(b4.at(-1).o, blk[0].o);
});

test('seleciona top 3 por |score|, pergunta Long/Short/Skip e abre no livro', async () => {
  const cl = fakeClient((st, opts) => (st.trend_strength.score.value > 0 ? 'long' : 'short'));
  const { jt, T } = make(cl);
  await jt.onBarClose(T);
  assert.equal(cl.calls.length, 3);
  const syms = cl.calls.map((c) => c.state.asset).sort();
  const want = jt.ranking().rows.slice(0, 3).map((r) => r.sym).sort();
  assert.deepEqual(syms, want);
  assert.ok(syms.includes('UP') && syms.includes('DN'), syms.join());
  const st = cl.calls[0].state;
  assert.ok(st.indicators_15m.rsi14 && st.indicators_4h.rsi14 && st.trend_strength.z_4h && !st.open_position);
  assert.equal(cl.calls[0].q.action.instructions, 'Given this data, which action has the highest profit potential: Long, Short or Skip?');
  assert.ok(jt.st.pos.UP.q > 0 && jt.st.pos.DN.q < 0);
  // 25% do capital por posicao, custo de ~1bp de meio spread
  assert.ok(Math.abs(jt.st.pos.UP.notional - 2500) < 1);
  assert.ok(Math.abs(jt.equity() - 10000) < 3, jt.equity());
  await jt.onBarClose(T); // mesma barra: nao repete
  assert.equal(cl.calls.length, 3);
});

test('com posicao pergunta manter/fechar; fecha, contabiliza P&L e funding', async () => {
  let mode = 'entry';
  const cl = fakeClient((st, opts) => (mode === 'entry' ? (st.trend_strength.score.value > 0 ? 'long' : 'short') : st.asset === 'UP' ? 'close' : 'keep'));
  const { jt, T, books, bars } = make(cl);
  await jt.onBarClose(T);
  mode = 'hold';
  jt.onStats('UP', { funding_timestamp: Date.now() + 5000, funding_rate: '0.01', mark_price: '100' }); // long paga 0,01%/h
  books.set('UP', book(102));
  bars.lastRefresh = T + BAR;
  const n0 = cl.calls.length;
  await jt.onBarClose(T + BAR);
  const holds = cl.calls.slice(n0).filter((c) => c.q.action.criteria.keep);
  assert.equal(holds.length, 3);
  const up = holds.find((c) => c.state.asset === 'UP').state.open_position;
  assert.equal(up.side, 'long');
  assert.ok(Math.abs(up.unrealized_pnl_pct - 2) < 0.05, up.unrealized_pnl_pct);
  assert.equal(holds[0].q.action.instructions, 'Given this data, should I keep the position open or close it?');
  assert.ok(!jt.st.pos.UP);
  const t = jt.st.closed[0];
  assert.equal(t.sym, 'UP');
  // ~+2% de 2500 menos 0,25 de funding menos ~2bp de spread
  assert.ok(Math.abs(t.pnl_usd - (50 - 0.25)) < 1.5, t.pnl_usd);
  assert.ok(Math.abs(t.funding_usd + 0.25) < 1e-3, t.funding_usd);
  assert.ok(Math.abs(jt.equity() - (10000 + t.pnl_usd)) < 3, jt.equity());
  const csv = fs.readFileSync(path.join(jt.dir, 'trades.csv'), 'utf8').trim().split('\n');
  assert.equal(csv.length, 2);
  assert.equal(jt.view().trades, 1);
});

test('erro da API: mantem posicao e nao abre', async () => {
  let fail = false;
  const cl = fakeClient((st) => (st.trend_strength.score.value > 0 ? 'long' : 'short'));
  const real = cl.decide;
  cl.decide = async (...a) => { if (fail) throw new Error('timeout'); return real(...a); };
  const { jt, T, bars } = make(cl);
  await jt.onBarClose(T);
  const n = Object.keys(jt.st.pos).length;
  fail = true; bars.lastRefresh = T + BAR;
  await jt.onBarClose(T + BAR);
  assert.equal(Object.keys(jt.st.pos).length, n);
  assert.equal(jt.st.errors, n);
  assert.ok(jt.st.decisions.slice(0, n).every((d) => d.action === 'mantem (erro)'));
});

test('limite de 65%: nao abre nem fecha abaixo dele', async () => {
  let mode = 'entry';
  const cl = fakeClient((st) => (mode === 'entry' ? (st.trend_strength.score.value > 0 ? 'long' : 'short') : 'close'),
    (st) => (mode === 'entry' ? (st.asset === 'UP' ? 0.64 : 0.66) : st.asset === 'DN' ? 0.6 : 0.7));
  const { jt, T, bars } = make(cl);
  await jt.onBarClose(T);
  assert.ok(!jt.st.pos.UP, 'UP com 64% nao abre');
  assert.ok(jt.st.pos.DN);
  assert.match(jt.st.decisions.find((d) => d.sym === 'UP').action, /^nao abre/);
  mode = 'hold'; bars.lastRefresh = T + BAR;
  await jt.onBarClose(T + BAR);
  assert.ok(jt.st.pos.DN, 'fechar com 60% mantem');
  assert.match(jt.st.decisions.find((d) => d.sym === 'DN' && d.kind === 'hold').action, /^mantem \(fechar 60%/);
  assert.equal(Object.keys(jt.st.pos).length, 1);
});

test('fecha posicoes antes de abrir: a vaga liberada na mesma barra e usada', async () => {
  const cl = fakeClient((st, opts) => (opts.includes('keep') ? 'close' : st.trend_strength.score.value > 0 ? 'long' : 'short'));
  const { jt, T, bars } = make(cl, { topN: 5, maxPositions: 3 });
  await jt.onBarClose(T);
  const first = Object.keys(jt.st.pos);
  assert.equal(first.length, 3);
  assert.equal(jt.st.decisions.filter((d) => d.action === 'limite de posicoes').length, 2);
  bars.lastRefresh = T + BAR;
  await jt.onBarClose(T + BAR);
  const d = jt.st.decisions.filter((x) => x.bar === T + BAR);
  assert.equal(d.filter((x) => x.kind === 'hold' && x.action === 'fechou').length, 3);
  const opened = d.filter((x) => x.kind === 'entry' && /^abriu/.test(x.action)).map((x) => x.sym);
  assert.equal(opened.length, 2, JSON.stringify(d.map((x) => [x.sym, x.kind, x.action])));
  assert.ok(opened.every((s) => !first.includes(s)), 'nao reabre na mesma barra o que acabou de fechar');
  assert.deepEqual(Object.keys(jt.st.pos).sort(), opened.sort());
});
