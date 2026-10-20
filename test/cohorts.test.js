// Carteiras das coortes da HyperTracker (src/cohorts.js): top 10, faixa neutra, mapa HL -> Lighter, pesos, P&L, custo, funding, horario e cota.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Cohorts, COH, SEGS, pickCohort, totals, decisionAt, readEnv } from '../src/cohorts.js';
import { OrderBook } from '../src/book.js';

const H = 3_600_000, MIN = 60_000;
const D0 = Date.parse('2026-10-16T00:00:00Z');
const close = (a, b, tol = 1e-12) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

function book(mid, bps) {
  const b = new OrderBook('x');
  const lv = (k) => Array.from({ length: 20 }, (_, i) => ({ price: String(mid * (1 + k * bps * 1e-4 * (i + 1))), size: String(1e9 / mid) }));
  b.apply({ type: 'subscribed/order_book', order_book: { asks: lv(1), bids: lv(-1), nonce: 1 } });
  return b;
}

/** linha do heatmap: segs = {id: [comprado, vendido]} */
const coin = (c, segs) => ({ coin: c, segments: Object.entries(segs).map(([id, [l, s]]) => ({ segmentId: +id, coin: c, totalValue: l + s, totalLongValue: l, totalShortValue: s, count: 1 })) });

test('pickCohort: top 10 por valor bruto, faixa neutra, sem par, sem livro, pesos iguais', () => {
  const heat = [
    coin('BTC', { 9: [100, 0] }), coin('ETH', { 9: [10, 80] }), coin('xyz:CL', { 9: [70, 0] }), coin('NEUT', { 9: [33, 32] }),
    coin('EDGE45', { 9: [45, 55] }), coin('NOMAP', { 9: [50, 0] }), coin('NOBOOK', { 9: [48, 0] }), coin('kPEPE', { 9: [0, 47] }),
    coin('A', { 9: [46, 0] }), coin('B', { 9: [45.5, 0] }), coin('C11', { 9: [45, 0] }), coin('OTHER', { 8: [1e9, 0] }),
  ];
  const map = { BTC: 'BTC', ETH: 'ETH', 'xyz:CL': 'WTI', NEUT: 'NEUT', EDGE45: 'EDGE45', NOBOOK: 'NOBOOK', kPEPE: '1000PEPE', A: 'A', B: 'B', C11: 'C11' };
  const r = pickCohort(heat, 9, map, (s) => s !== 'NOBOOK');
  assert.deepEqual(r.cands.map((c) => c.coin), ['BTC', 'EDGE45', 'ETH', 'xyz:CL', 'NEUT', 'NOMAP', 'NOBOOK', 'kPEPE', 'A', 'B']); // EDGE45 vale 100 (empate com BTC: ordem do nome); C11 e o 11o; OTHER e de outra coorte
  const dec = Object.fromEntries(r.cands.map((c) => [c.coin, c.decision]));
  assert.deepEqual(dec, { BTC: 'long', ETH: 'short', 'xyz:CL': 'long', EDGE45: 'neutro', NEUT: 'neutro', NOMAP: 'sem par na Lighter', NOBOOK: 'sem livro', kPEPE: 'short', A: 'long', B: 'long' });
  assert.equal(r.n, 6);
  assert.deepEqual(r.w, { BTC: 1 / 6, ETH: -1 / 6, WTI: 1 / 6, '1000PEPE': -1 / 6, A: 1 / 6, B: 1 / 6 });
  assert.ok(close(Object.values(r.w).reduce((a, w) => a + Math.abs(w), 0), 1));
});

test('pickCohort: dois coins no mesmo simbolo da Lighter somam (e se anulam)', () => {
  const heat = [coin('xyz:SP500', { 9: [90, 10] }), coin('mkts:US500', { 9: [5, 60] }), coin('BTC', { 9: [50, 0] })];
  const map = { 'xyz:SP500': 'US500', 'mkts:US500': 'US500', BTC: 'BTC' };
  const r = pickCohort(heat, 9, map, () => true);
  assert.equal(r.n, 3);
  assert.deepEqual(r.w, { BTC: 1 / 3 }); // +1/3 e -1/3 em US500 se anulam
  const r2 = pickCohort([coin('xyz:SP500', { 9: [90, 10] }), coin('mkts:US500', { 9: [60, 5] })], 9, map, () => true);
  assert.deepEqual(r2.w, { US500: 1 });
});

test('pickCohort: coorte sem posicoes = caixa; totals soma todos os ativos', () => {
  const heat = [coin('BTC', { 9: [30, 10] }), coin('ETH', { 9: [0, 20] }), coin('SOL', { 8: [5, 5] })];
  assert.deepEqual(pickCohort(heat, 15, {}, () => true), { cands: [], w: {}, n: 0 });
  const t = totals(heat, 9);
  assert.deepEqual(t, { value: 60, long: 30, short: 30, bias: 0.5, count: 2, coins: 2 });
});

test('decisionAt e readEnv', () => {
  assert.equal(decisionAt(Date.parse('2026-10-16T05:59:59Z')), D0);
  assert.equal(decisionAt(Date.parse('2026-10-16T06:00:00Z')), D0 + 6 * H);
  assert.equal(decisionAt(Date.parse('2026-10-16T23:45:00Z')), D0 + 18 * H);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coh-')), '.env');
  fs.writeFileSync(f, '# x\r\nHYPERTRACKER_KEY=abc.def-1\r\nOUTRA = 2\n');
  assert.deepEqual(readEnv(f), { HYPERTRACKER_KEY: 'abc.def-1', OUTRA: '2' });
  assert.deepEqual(readEnv(f + '.nada'), {});
});

/** mundo: 4 ativos na Lighter com livro de 2bp por nivel; heatmap configuravel; funding constante por simbolo */
function world({ dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coh-')), heat, fundRate = {} } = {}) {
  const mapFile = path.join(dir, 'map.json');
  fs.writeFileSync(mapFile, JSON.stringify({ gerado: 'x', mapa: { BTC: { lighter: 'BTC' }, ETH: { lighter: 'ETH' }, 'xyz:CL': { lighter: 'WTI' }, HYPE: { lighter: 'HYPE' } } }));
  const mids = { BTC: 100, ETH: 50, WTI: 80, HYPE: 40 };
  const markets = Object.keys(mids).map((s, i) => ({ symbol: s, market_id: i + 1 }));
  const recorder = { books: new Map() };
  const setMids = (m) => { Object.assign(mids, m); for (const [s, p] of Object.entries(mids)) recorder.books.set(s, book(p, 2)); };
  setMids({});
  const calls = { heat: [], funding: [] };
  const w = { heat };
  const c = new Cohorts({ dataDir: dir, recorder, markets: () => markets, mapFile, envFile: path.join(dir, 'nada'),
    fetchHeat: async (v) => { calls.heat.push(v); if (w.fail) throw new Error('falhou'); return typeof w.heat === 'function' ? w.heat(v) : w.heat; },
    fetchFunding: async (id, a, b) => {
      calls.funding.push([id, a, b]);
      const s = markets[id - 1].symbol, out = [];
      for (let t = Math.ceil(a / H) * H; t <= b; t += H) out.push([t, fundRate[s] ?? 0]);
      return out;
    } });
  return { c, dir, calls, setMids, w, recorder };
}

// 60 ativos de enchimento (fora da Lighter) para o heatmap passar da checagem de tamanho
const filler = Array.from({ length: 60 }, (_, i) => coin(`F${i}`, { 1: [1, 0] }));
const heatA = [coin('BTC', { 9: [100, 0], 8: [0, 100] }), coin('ETH', { 9: [0, 90], 8: [80, 0] }), coin('xyz:CL', { 9: [70, 10] }), coin('HYPE', { 9: [30, 30] }), ...filler];

test('Cohorts: primeira decisao cria 32 carteiras, 2 chamadas, custo cobrado no periodo seguinte', async () => {
  const { c, calls } = world({ heat: heatA });
  await c.onBarClose(D0, D0 + 8000);
  assert.deepEqual(calls.heat, ['all', '24h']);
  assert.equal(Object.keys(c.st.books).length, SEGS.length * 2);
  assert.equal(c.st.calls.n, 2);
  const b = c.st.books['all:9'];
  assert.deepEqual(Object.keys(b.hold).sort(), ['BTC', 'ETH', 'WTI']); // HYPE neutro
  assert.ok(close(b.hold.BTC, 1 / 3) && close(b.hold.ETH, -1 / 3));
  assert.ok(close(b.pend.turn, 1));
  const cost = (s) => c.recorder.books.get(s).cost(10_000 / 3);
  assert.ok(close(b.pend.cost, (cost('BTC') + cost('ETH') + cost('WTI')) / 3));
  assert.deepEqual(c.st.books['all:15'].hold, {}); // coorte sem posicoes: caixa
  assert.equal(c.st.rows.length, 0);
  // mesma decisao de novo: nada
  await c.onBarClose(D0 + 15 * MIN, D0 + 15 * MIN + 8000);
  assert.equal(calls.heat.length, 2);
  // arquivos
  assert.ok(fs.existsSync(path.join(c.dir, 'raw', '2026-10-16', '0000_all.json.gz')));
  const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(c.dir, 'raw', '2026-10-16', '0000_24h.json.gz'))));
  assert.equal(raw.length, heatA.length);
  const picks = fs.readFileSync(path.join(c.dir, 'picks.csv'), 'utf8').trim().split('\n');
  assert.equal(picks.length, 1 + 2 * (4 + 2 + 10)); // cabecalho + por visao: coorte 9 (4 ativos), 8 (2), 1 (10 dos 60 de enchimento)
  assert.ok(picks.some((l) => l.includes(',all,9,4,HYPE,HYPE,') && l.includes(',neutro,')));
});

test('Cohorts: P&L do periodo no mid, funding da Lighter e giro na decisao seguinte', async () => {
  const { c, setMids, calls, w } = world({ heat: heatA, fundRate: { BTC: 1e-5, ETH: -2e-5, WTI: 0 } });
  await c.onBarClose(D0, D0 + 8000);
  const pend = c.st.books['all:9'].pend.cost;
  setMids({ BTC: 110, ETH: 45, WTI: 80 });
  // nova decisao: BTC e ETH continuam, CL sai da coorte 9 (agora neutro)
  w.heat = [coin('BTC', { 9: [100, 0] }), coin('ETH', { 9: [0, 90] }), coin('xyz:CL', { 9: [40, 40] }), ...filler];
  await c.onBarClose(D0 + 6 * H, D0 + 6 * H + 8000);
  const r = c.st.rows.find((x) => x.k === 'all:9');
  const bruto = (1 / 3) * (110 / 100 - 1) + (-1 / 3) * (45 / 50 - 1) + (1 / 3) * 0;
  assert.ok(close(r.bruto, bruto, 1e-9), `${r.bruto} vs ${bruto}`);
  const funding = -(1 / 3) * 6 * 1e-5 - (-1 / 3) * 6 * -2e-5; // 6 carimbos em (D0, D0+6h]
  assert.ok(close(r.funding, funding, 1e-9), `${r.funding} vs ${funding}`);
  assert.ok(close(r.custo, pend));
  assert.ok(close(r.liq, r.bruto - r.custo + r.funding));
  assert.equal(r.miss, 0); assert.equal(r.nofund, 0);
  const b = c.st.books['all:9'];
  assert.ok(close(b.hold.BTC, 0.5) && close(b.hold.ETH, -0.5) && !('WTI' in b.hold));
  assert.ok(close(b.pend.turn, 1 / 6 + 1 / 6 + 1 / 3));
  assert.equal(b.lastPx.BTC, 110);
  // funding pedido so para os simbolos em carteira, desde a decisao anterior
  assert.ok(calls.funding.every(([, a, bb]) => a === D0 && bb === D0 + 6 * H));
  assert.equal(new Set(calls.funding.map((x) => x[0])).size, 3);
  // view
  const v = c.view(D0 + 6 * H + MIN);
  const vb = v.books.find((x) => x.k === 'all:9');
  assert.equal(vb.periods, 1);
  assert.ok(close(vb.sum, r.liq * 1e4, 1e-9));
  assert.equal(vb.cands.length, 3);
  assert.equal(v.books.length, 32);
  assert.equal(v.next, D0 + 12 * H);
});

test('Cohorts: falha na API tenta de novo na barra seguinte; depois de 90 min a decisao e perdida e a carteira mantida', async () => {
  const { c, w, calls, setMids } = world({ heat: heatA });
  await c.onBarClose(D0, D0 + 8000);
  w.fail = true;
  await c.onBarClose(D0 + 6 * H, D0 + 6 * H + 8000);
  assert.equal(c.st.lastT, D0);
  assert.match(c.lastError.msg, /heatmap all: falhou/);
  await c.onBarClose(D0 + 6 * H + 15 * MIN, D0 + 6 * H + 15 * MIN + 8000);
  assert.equal(calls.heat.length, 4); // 2 + 1 + 1 (falha na primeira visao)
  await c.onBarClose(D0 + 7 * H + 45 * MIN, D0 + 7 * H + 45 * MIN + 8000); // > 90 min: perdida
  assert.equal(calls.heat.length, 4);
  assert.deepEqual(c.st.skipped, [D0 + 6 * H]);
  // proxima decisao mede desde D0 com a carteira antiga
  w.fail = false; setMids({ BTC: 105 });
  await c.onBarClose(D0 + 12 * H, D0 + 12 * H + 8000);
  const r = c.st.rows.find((x) => x.k === 'all:9');
  assert.equal(r.from, D0); assert.equal(r.T, D0 + 12 * H);
  assert.ok(close(r.bruto, (1 / 3) * 0.05, 1e-9));
});

test('Cohorts: cota diaria', async () => {
  const { c, w, calls } = world({ heat: heatA });
  c.st.calls = { day: '2026-10-16', n: COH.dayCap - 1 };
  await c.onBarClose(D0, D0 + 8000);
  assert.equal(calls.heat.length, 0);
  assert.match(c.lastError.msg, /limite diário/);
  c.st.calls = { day: '2026-10-15', n: COH.dayCap }; // dia anterior: zera
  await c.onBarClose(D0, D0 + 8000);
  assert.equal(calls.heat.length, 2);
  assert.equal(c.st.calls.day, '2026-10-16');
  void w;
});

test('Cohorts: heatmap curto demais nao decide; estado sobrevive a reinicio', async () => {
  const { c, w, dir } = world({ heat: heatA.slice(0, 10) });
  await c.onBarClose(D0, D0 + 8000);
  assert.equal(c.st.lastT, null);
  assert.match(c.lastError.msg, /veio com 10 ativos/);
  w.heat = heatA;
  await c.onBarClose(D0 + 15 * MIN, D0 + 15 * MIN + 8000);
  assert.equal(c.st.lastT, D0);
  const again = world({ dir, heat: heatA });
  assert.equal(again.c.st.lastT, D0);
  assert.equal(Object.keys(again.c.st.books).length, 32);
});

test('heatmap real (2026-10-15 19h UTC): Smart Money, todas as posicoes', () => {
  const f = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), 'cohorts_heat.json.gz');
  const heat = JSON.parse(zlib.gunzipSync(fs.readFileSync(f))).heatmap;
  const map = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(new URL('../hl_lighter_map.json', import.meta.url))).mapa).map(([k, v]) => [k, v.lighter]));
  const r = pickCohort(heat, 9, map, () => true);
  assert.deepEqual(r.cands.map((c) => c.coin), ['BTC', 'ETH', 'HYPE', 'ZEC', 'xyz:SP500', 'SOL', 'xyz:SKHX', 'NEAR', 'xyz:XYZ100', 'xyz:GOLD']);
  assert.deepEqual(r.cands.map((c) => c.decision), ['neutro', 'short', 'long', 'long', 'short', 'long', 'long', 'long', 'short', 'long']);
  assert.deepEqual(Object.keys(r.w).sort(), ['ETH', 'HYPE', 'NEAR', 'SKHYNIXUSD', 'SOL', 'US100', 'US500', 'XAU', 'ZEC']);
  assert.equal(r.n, 9);
});
