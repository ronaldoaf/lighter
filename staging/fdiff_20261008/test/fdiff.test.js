// Diferencial de funding em modo sombra (src/fdiff.js): janelas, universo, tranche, P&L, custo, espera do carimbo, decisoes perdidas.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FundingDiff, FDIFF, binanceName, barStats, sumL, sumB, pick, avgHold } from '../src/fdiff.js';
import { OrderBook } from '../src/book.js';

const H = 3_600_000, DAY = 86_400_000, BAR = 15 * 60_000, MIN = 60_000;
const T0 = Date.parse('2026-09-20T18:00:00Z');
const close = (a, b, tol = 1e-12) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

function book(mid, bps) {
  const b = new OrderBook('x');
  const lv = (k) => Array.from({ length: 20 }, (_, i) => ({ price: String(mid * (1 + k * bps * 1e-4 * (i + 1))), size: String(1e9 / mid) }));
  b.apply({ type: 'subscribed/order_book', order_book: { asks: lv(1), bids: lv(-1), nonce: 1 } });
  return b;
}

/**
 * 30 cripto C00..C29 com funding constante na Lighter ((i - 15) x 1e-6 por hora) e na Binance (1e-5 por carimbo de 8h):
 * o ranking e o de i (compra C29, C28, C27; vende C00, C01, C02). Mais 6 ativos que o universo deve tirar.
 */
function world(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fd-'))) {
  const C = Array.from({ length: 30 }, (_, i) => `C${String(i).padStart(2, '0')}`);
  const syms = [...C, 'LOWVOL', 'YOUNG', 'NOBIN', 'NEWBIN', 'STOCK', 'DEAD'];
  const markets = syms.map((s, i) => ({ symbol: s, market_id: 100 + i }));
  const byId = new Map(markets.map((m) => [m.market_id, m.symbol]));
  const idx = (s) => (s.startsWith('C') ? +s.slice(1) : 20);
  const price = (s, t) => 100 * Math.exp((idx(s) - 15) * 0.001 * (t - T0) / DAY);
  const bars = {};
  for (const s of syms) {
    bars[s] = [];
    for (let t = T0 - 10 * DAY; t < T0 + 6 * DAY; t += BAR) {
      if (s === 'DEAD' && t >= T0 - H) continue; // sem negocio desde T0 - 1h
      bars[s].push({ t, o: price(s, t), h: price(s, t), l: price(s, t), c: price(s, t + BAR), V: s === 'LOWVOL' ? 1000 : 100_000 });
    }
  }
  // C29 passa a receber funding depois de T0+12h: em T0+24h sai do topo (fd7 = 0) e C26 entra
  const rateL = (s, t) => (s === 'C29' && t > T0 + 12 * H ? -13 * 14e-6 : (idx(s) - 15) * 1e-6);
  const w = { dir, price, rateL, pub: Infinity, namesFail: false, calls: { L: 0, B: 0 } };
  const fetchers = {
    names: async () => { if (w.namesFail) throw new Error('fora do ar'); return new Set(syms.filter((s) => s !== 'NOBIN').map((s) => s + 'USDT')); },
    lighter: async (id, a, b) => { // como a API: nada depois do fim pedido (a decisao pede ate T)
      w.calls.L++;
      const s = byId.get(id), out = [];
      for (let t = Math.ceil((a - 2 * H) / H) * H; t <= b; t += H) if (t <= w.pub) out.push([t, rateL(s, t)]);
      return out;
    },
    binance: async (bs, from, to) => {
      w.calls.B++;
      const s = bs.replace(/USDT$/, ''), start = s === 'NEWBIN' ? T0 - 5 * DAY : -Infinity, out = [];
      for (let t = Math.ceil(from / (8 * H)) * 8 * H; t <= (to ?? T0 + 10 * DAY); t += 8 * H) if (t >= start && t + 1 >= from) out.push([t + 1, 1e-5]);
      return out;
    },
  };
  const recorder = { books: new Map(syms.map((s) => [s, book(100, 2)])) }; // custo de 2bp por perna
  w.make = () => new FundingDiff({ dataDir: dir, rest: null, bars: { load: (s) => bars[s] ?? [] },
    trend: { load: (s) => [{ t: s === 'YOUNG' ? T0 - 5 * DAY : T0 - 40 * DAY, c: 1 }] },
    recorder, live: { lastPx: new Map() }, classOf: (s) => (s === 'STOCK' ? 'acoes' : 'cripto'), markets: () => markets, fetchers });
  return w;
}

test('nome na Binance: mesma ordem do backtest', () => {
  const n = new Set(['BTCUSDT', '1000PEPEUSDT', 'SHIBUSDT', '1000000MOGUSDT']);
  assert.equal(binanceName('BTC', n), 'BTCUSDT');
  assert.equal(binanceName('PEPE', n), '1000PEPEUSDT');
  assert.equal(binanceName('1000PEPE', n), '1000PEPEUSDT');
  assert.equal(binanceName('1000SHIB', n), 'SHIBUSDT');
  assert.equal(binanceName('1000MOG', n), '1000000MOGUSDT');
  assert.equal(binanceName('XYZ', n), null);
});

test('candles: vol 24h em [T-24h, T), negocio na ultima hora, fechamento com ffill', () => {
  const b = [{ t: T0 - DAY - BAR, c: 1, V: 7 }, { t: T0 - DAY, c: 2, V: 10 }, { t: T0 - 2 * H, c: 3, V: 5 }, { t: T0, c: 9, V: 100 }];
  assert.deepEqual(barStats(b, T0), { c: 3, vol24: 15, alive: false });
  assert.deepEqual(barStats([...b.slice(0, 3), { t: T0 - BAR, c: 4, V: 1 }], T0), { c: 4, vol24: 16, alive: true });
  assert.deepEqual(barStats(b.slice(0, 1), T0), { c: 1, vol24: 0, alive: false }); // so candle antigo: fechamento vale, volume nao
});

test('janelas de funding: Lighter (T-168h, T], Binance pela hora do carimbo em [T-168h, T)', () => {
  const L = new Map([[T0 - 168 * H, 1], [T0 - 167 * H, 2], [T0, 4], [T0 + H, 8]]);
  assert.equal(sumL(L, T0 - 168 * H, T0), 6);
  const B = new Map([[T0 - 168 * H + 3, 1], [T0 - 168 * H - 1, 2], [T0 - 8 * H + 1, 4], [T0 + 2, 8]]);
  assert.equal(sumB(B, T0 - 168 * H, T0), 5);
});

test('tranche: n = 10% do universo, maior sinal comprado, empate em ordem alfabetica', () => {
  const u = (k) => Array.from({ length: k }, (_, i) => ({ sym: `S${String(i).padStart(2, '0')}`, s: i }));
  assert.equal(pick(u(39)).n, 3);
  assert.equal(pick(u(40)).n, 4);
  assert.deepEqual(pick(u(9)), { n: 0, long: [], short: [], w: {} });
  const p = pick(u(30));
  assert.deepEqual(p.long, ['S29', 'S28', 'S27']);
  assert.deepEqual(p.short, ['S00', 'S01', 'S02']);
  assert.ok(close(p.w.S29, 0.5 / 3) && close(p.w.S00, -0.5 / 3));
  const t = pick([{ sym: 'B', s: 0 }, { sym: 'A', s: 0 }, ...u(8).map((x) => ({ ...x, s: x.s + 1 }))]); // 10 ativos, empate no fundo
  assert.deepEqual(t.short, ['A']);
  assert.deepEqual(avgHold([{ w: { A: 0.7 } }, { w: { A: 0.7, B: -0.7 } }]), { A: 0.7, B: -0.35 });
});

test('fluxo: inicio ao vivo, P&L do periodo, custo no periodo seguinte, espera do carimbo, decisoes perdidas e reinicio', async () => {
  const w = world();
  let fd = w.make();

  // 18:00 de D: so a carteira das 18h comeca (as outras esperam a propria hora); 7 tranches anteriores reconstruidas, giro zero
  await fd.onBarClose(T0, T0 + 2 * MIN);
  assert.deepEqual(Object.keys(fd.st.books), ['18']);
  const b18 = fd.st.books[18];
  assert.equal(b18.lastT, T0);
  assert.equal(b18.targets.length, 7);
  assert.deepEqual(fd.st.last.long, ['C29', 'C28', 'C27']);
  assert.deepEqual(fd.st.last.short, ['C00', 'C01', 'C02']);
  assert.equal(fd.st.last.univ.length, 30); // sem LOWVOL, YOUNG, NOBIN, NEWBIN (perp novo na Binance), STOCK e DEAD
  const u29 = fd.st.last.univ.find((x) => x.sym === 'C29');
  assert.ok(close(u29.fl, 168 * 14e-6) && close(u29.fb, 21 * 1e-5) && u29.nl === 168, JSON.stringify(u29));
  assert.ok(close(b18.hold.C29, 0.5 / 3) && close(b18.hold.C02, -0.5 / 3));
  assert.equal(b18.pend.turn, 0);
  assert.equal(fd.st.rows.length, 0);

  // as outras carteiras comecam nas proprias horas
  for (const k of [6, 12, 18]) await fd.onBarClose(T0 + k * H, T0 + k * H + 2 * MIN);
  assert.deepEqual(Object.keys(fd.st.books).sort(), ['0', '12', '18', '6']);
  assert.equal(fd.st.rows.length, 0);

  const old = { ...fd.st.books[18].hold };
  await fd.onBarClose(T0 + 24 * H, T0 + 24 * H + 2 * MIN);
  const r = fd.st.rows.at(-1);
  assert.equal(r.h, 18); assert.equal(r.from, T0); assert.equal(r.T, T0 + 24 * H);
  let bruto = 0, funding = 0;
  for (const [s, x] of Object.entries(old)) {
    bruto += x * (w.price(s, T0 + 24 * H) / w.price(s, T0) - 1);
    for (let t = T0 + H; t <= T0 + 24 * H; t += H) funding -= x * w.rateL(s, t);
  }
  assert.ok(close(r.bruto, bruto), `bruto ${r.bruto} x ${bruto}`);
  assert.ok(close(r.funding, funding), `funding ${r.funding} x ${funding}`);
  assert.equal(r.custo, 0);
  assert.ok(close(r.liq, bruto + funding));
  assert.deepEqual(fd.st.last.long, ['C28', 'C27', 'C26']);
  const nb = fd.st.books[18];
  assert.ok(close(nb.hold.C29, 1 / 7) && close(nb.hold.C26, 1 / 42) && close(nb.hold.C28, 0.5 / 3));
  assert.ok(close(nb.pend.turn, 1 / 21), String(nb.pend.turn));
  assert.ok(close(nb.pend.cost, 2e-4 / 21, 1e-9), String(nb.pend.cost)); // 2bp por perna no livro

  for (const k of [30, 36, 42]) await fd.onBarClose(T0 + k * H, T0 + k * H + 2 * MIN);

  // carimbo da hora da decisao ainda nao publicado: espera; na barra seguinte decide (e cobra o custo medido na anterior)
  w.pub = T0 + 47 * H;
  const n0 = fd.st.rows.length;
  await fd.onBarClose(T0 + 48 * H, T0 + 48 * H + 2 * MIN);
  assert.equal(fd.st.rows.length, n0);
  assert.equal(fd.waiting.T, T0 + 48 * H);
  w.pub = Infinity;
  await fd.onBarClose(T0 + 48 * H + BAR, T0 + 48 * H + 17 * MIN);
  assert.equal(fd.st.rows.length, n0 + 1);
  assert.equal(fd.waiting, null);
  const r48 = fd.st.rows.at(-1);
  assert.equal(r48.T, T0 + 48 * H);
  assert.ok(close(r48.custo, 2e-4 / 21, 1e-9));
  assert.equal(fd.st.last.univ.find((x) => x.sym === 'C29').nl, 168);

  // app parado de T0+48h a T0+96h: as 8 decisoes perdidas saem em ordem, com os dados ate cada instante
  await fd.onBarClose(T0 + 96 * H + BAR, T0 + 96 * H + 17 * MIN);
  const late = fd.st.rows.slice(n0 + 1);
  assert.deepEqual(late.map((x) => (x.T - T0) / H), [54, 60, 66, 72, 78, 84, 90, 96]);
  for (const x of late) assert.equal(x.T - x.from, DAY);

  // reinicio: estado e carteiras voltam do disco; o funding em memoria e baixado de novo
  fd = w.make();
  assert.equal(fd.st.rows.length, n0 + 9);
  await fd.onBarClose(T0 + 102 * H, T0 + 102 * H + 2 * MIN);
  const rr = fd.st.rows.at(-1);
  assert.equal(rr.h, 0); assert.equal(rr.from, T0 + 78 * H);
  assert.ok(Number.isFinite(rr.liq));
  const csv = fs.readFileSync(path.join(w.dir, 'shadow', 'fdiff', 'rows.csv'), 'utf8').trim().split('\n');
  assert.equal(csv.length, 1 + fd.st.rows.length);

  const v = fd.view(T0 + 102 * H + 5 * MIN);
  assert.equal(v.periods, fd.st.rows.length);
  assert.equal(v.books.length, 4);
  assert.equal(v.next, T0 + 108 * H);
  assert.ok(Number.isFinite(v.mean) && Number.isFinite(v.sum));
});

test('falha na lista da Binance: nao decide e tenta de novo na barra seguinte', async () => {
  const w = world();
  const fd = w.make();
  w.namesFail = true;
  await fd.onBarClose(T0, T0 + 2 * MIN);
  assert.deepEqual(fd.st.books, {});
  assert.match(fd.lastError.msg, /exchangeInfo/);
  w.namesFail = false;
  await fd.onBarClose(T0 + BAR, T0 + 17 * MIN);
  assert.equal(fd.st.books[18]?.lastT, T0);
  // decisao velha demais para comecar uma carteira nova
  const w2 = world(), f2 = w2.make();
  await f2.onBarClose(T0 + 2 * H, T0 + 2 * H + 2 * MIN);
  assert.deepEqual(f2.st.books, {});
});

test('regra congelada', () => {
  assert.deepEqual(FDIFF.hours, [0, 6, 12, 18]);
  assert.equal(FDIFF.winH, 168); assert.equal(FDIFF.q, 0.1); assert.equal(FDIFF.hold, 7);
  assert.equal(FDIFF.liq, 5e5); assert.equal(FDIFF.minAgeD, 14);
});
