// Grade de fim de semana (src/wkdgrid.js): paridade com a referencia do estudo (scripts/export_wkdgrid_cases.py -> grid_window,
// prep e windows48 do Python) em fins de semana reais da Binance, e a trilha da Lighter (negocios, livro, buracos) sem rede.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { GF, weekendAt, hourVol, gridBar, gridTrade, lighterResult, WeekendGrid } from '../src/wkdgrid.js';
import { OrderBook } from '../src/book.js';

const MIN = 60_000, H = 3_600_000;
const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const { params, cases } = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root, 'test', 'wkdgrid_cases.json.gz'))).toString());
const bar = (x) => ({ t: x[0], o: x[1], h: x[2], l: x[3], c: x[4] });
const label = (cs) => `${cs.sym} ${new Date(cs.T0).toISOString().slice(0, 10)} (${(cs.T1 - cs.T0) / H}h)`;
const winBars = (cs) => cs.bars.filter((x) => x[0] >= cs.T0 && x[0] < cs.T1).map(bar);
const one = (sym) => ({ ...GF, syms: [sym], carteira: [sym] });

/** grade da referencia num fim de semana (gridBar + fechamento), com os eventos no formato do Python */
function runRef(cs, g, R = GF) {
  const s = { a: null, g, lvl: 0, pos: 0, cash: 0, nf: 0, halted: false }, ev = [], cost = R.custo[cs.sym];
  const wb = winBars(cs);
  s.a = wb[0].o;
  let stopOpen = false;
  wb.forEach((b, i) => {
    for (const e of gridBar(s, b, R)) {
      if (e.side === 'stop') {
        if (e.qty > 0) s.cash -= e.qty * e.px * (1 + cost); else s.cash += (-e.qty) * e.px * (1 - cost);
        stopOpen = e.px !== s.a * (1 + Math.sign(e.k) * (R.J + 1) * g); // abriu alem do nivel (buraco)
      }
      ev.push([i, e.side, e.k]);
    }
  });
  if (!s.halted && s.pos !== 0) {
    const px = wb.at(-1).c;
    s.cash += s.pos * px - Math.abs(s.pos) * px * cost;
    ev.push([wb.length - 1, 'close', s.lvl]);
  }
  return { pnl: s.cash / (R.J * s.a), nf: s.nf, halted: s.halted ? 1 : 0, ev, stopOpen };
}

test('parametros iguais aos da referencia', () => {
  assert.equal(GF.c, params.c); assert.equal(GF.J, params.J); assert.equal(GF.eps, params.eps);
  assert.equal(GF.volH, params.volH); assert.equal(GF.volMin, params.volMin);
  for (const [s, v] of Object.entries(params.custo)) assert.equal(GF.custo[s], v);
});

test('janela sexta 17:00 -> domingo 17:00 ET, com as trocas de horario de verao (47h e 49h)', () => {
  for (const cs of cases) {
    const w = weekendAt(cs.T0 + H);
    assert.equal(w.T0, cs.T0, label(cs)); assert.equal(w.T1, cs.T1, label(cs));
    assert.equal(weekendAt(cs.T0 - MIN).T0, cs.T0); // sexta antes das 17:00: a janela e a proxima
    assert.equal(weekendAt(cs.T1).T0, weekendAt(cs.T1 + 6 * 24 * H).T0); // domingo 17:00: ja e a da semana seguinte
    assert.equal(winBars(cs).length, cs.nbars);
  }
  assert.ok(cases.some((c) => c.T1 - c.T0 === 49 * H) && cases.some((c) => c.T1 - c.T0 === 47 * H));
  assert.equal(weekendAt(Date.parse('2026-10-10T12:00:00Z')).id, '2026-10-09');
  assert.equal(new Date(weekendAt(Date.parse('2026-10-10T12:00:00Z')).T0).toISOString(), '2026-10-09T21:00:00.000Z');
  assert.equal(new Date(weekendAt(Date.parse('2026-10-31T12:00:00Z')).T1).toISOString(), '2026-11-01T22:00:00.000Z'); // termina em EST
});

for (const cs of cases) {
  test(`paridade com o Python: vol, degrau, preenchimentos e resultado: ${label(cs)}`, () => {
    const before = cs.bars.filter((x) => x[0] < cs.T0).map(bar);
    const v = hourVol(before, cs.T0);
    assert.ok(Math.abs(v / cs.vol - 1) < 1e-12, `vol js ${v} x py ${cs.vol}`);
    const ref = runRef(cs, cs.g);
    assert.equal(ref.pnl, cs.pnl, 'resultado bit a bit com o degrau do Python');
    assert.equal(ref.nf, cs.nf); assert.equal(ref.halted, cs.halted);
    assert.deepEqual(ref.ev, cs.events);
    const own = runRef(cs, GF.c * v); // degrau calculado no JS
    assert.deepEqual(own.ev, cs.events);
    assert.ok(Math.abs(own.pnl - cs.pnl) < 1e-12);
  });
}

// ---------------------------------------------------------------- simulacao do modulo (Binance e Lighter falsas)
/** API falsa da Binance servindo os candles do caso (klines no formato da fapi) */
function fakeBinance(cs) {
  const all = cs.bars.map((x) => [x[0], String(x[1]), String(x[2]), String(x[3]), String(x[4]), '1']);
  return async (url) => {
    const u = new URL(url), st = +u.searchParams.get('startTime'), en = u.searchParams.get('endTime'), lim = +u.searchParams.get('limit');
    return all.filter((x) => x[0] >= st && (en === null || x[0] <= +en)).slice(0, lim);
  };
}
/** livro raso em volta de mid: 20 niveis de cada lado, passo de 0,1 bp, US$2k por nivel */
function bookAt(mid, step = 1e-5, usd = 2000) {
  const b = new OrderBook('x');
  const lv = (k) => Array.from({ length: 20 }, (_, i) => { const p = mid * (1 + k * step * (i + 1)); return { price: String(p), size: String(usd / p) }; });
  b.apply({ type: 'subscribed/order_book', order_book: { asks: lv(1), bids: lv(-1), nonce: 1 } });
  return b;
}
function fakeShadow(sym, { live = null } = {}) {
  const books = new Map();
  return { books, recorder: { books, markHot() {}, snapshot() {} }, live, markets: () => [{ symbol: sym, market_id: 7 }] };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wg-'));
/** fita sintetica: os extremos de cada candle na ordem do caminho do backtest (alta: minima e depois maxima; baixa: o contrario) */
const tape = (b) => (b.c < b.o ? [[10_000, b.h], [40_000, b.l]] : [[10_000, b.l], [40_000, b.h]]).map(([dt, p]) => ({ timestamp: b.t + dt, price: String(p), usd_amount: '1000' }));
const evOf = (dir, trilha) => fs.readFileSync(path.join(dir, 'shadow', 'wkd_grid', 'events.csv'), 'utf8').trim().split('\n').slice(1)
  .map((l) => l.split(',')).filter((c) => c[1] === trilha);

async function simulate(cs, { restartAt = null } = {}) {
  const dir = tmp(), R = one(cs.sym), sh = fakeShadow(cs.sym), wb = winBars(cs);
  const rest = { calls: [], candles: async (id, from, to, res) => { rest.calls.push({ id, from, to, res }); return wb.filter((b) => b.t >= from && b.t + MIN <= to).map((b) => ({ ...b, V: 1 })); } };
  const mk = () => new WeekendGrid({ dataDir: dir, shadow: sh, rest, R, fetchJSON: fakeBinance(cs), gapMs: 0 });
  let wg = mk();
  sh.books.set(cs.sym, bookAt(wb[0].o));
  await wg.tick(cs.T0 + 1000); // abre (ancora = mid = abertura do primeiro candle) e busca a vol
  await wg.tick(cs.T0 + 2000); // degrau conhecido: sai do modo buffer
  let restarted = false;
  for (const b of wb) {
    if (restartAt !== null && !restarted && b.t >= restartAt) { // reinicio (o app grava o estado ao encerrar): 10 min sem negocios
      wg.save(); wg = mk(); restarted = true;
      continue;
    }
    if (restarted && b.t < restartAt + 10 * MIN) continue;
    for (const x of tape(b)) { sh.books.set(cs.sym, bookAt(+x.price)); wg.onTrade(cs.sym, x); }
    if (b.t % H === 0) await wg.tick(b.t + MIN + 3000);
  }
  // ultimo negocio = fechamento do ultimo candle (preco do fechamento do backtest), se ele nao preencher nada a mais
  const last = wb.at(-1), L = wg.st.cur.L[cs.sym], lv = (k) => L.a * (1 + k * L.g);
  const safe = L.halted || (last.c > lv(L.lvl - 1) * (1 - GF.eps) && last.c < lv(L.lvl + 1) * (1 + GF.eps));
  sh.books.set(cs.sym, bookAt(last.c));
  if (safe) wg.onTrade(cs.sym, { timestamp: cs.T1 - 1, price: String(last.c), usd_amount: '1000' });
  await wg.tick(cs.T1 + 5000); // Binance ate o ultimo candle; Lighter fecha no livro
  await wg.tick(cs.T1 + 6000); // janela concluida
  return { wg, dir, rest, safe };
}

for (const cs of cases) {
  test(`modulo ao vivo: trilha da Binance = referencia e trilha da Lighter (fita sintetica) = mesmos preenchimentos: ${label(cs)}`, async () => {
    const ref = runRef(cs, cs.g);
    const { wg, dir, safe } = await simulate(cs);
    assert.equal(wg.st.cur, null, 'janela fechada');
    const d = wg.st.done.at(-1), a = d.assets[cs.sym];
    assert.ok(Math.abs(a.theo / 1e4 - cs.pnl) < 1e-12, `teorico ${a.theo} x ${cs.pnl * 1e4}`);
    assert.equal(a.nfB, cs.nf); assert.equal(a.stopB !== 0 ? 1 : 0, cs.halted);
    const bin = evOf(dir, 'binance').map((c) => [c[4], +c[5]]);
    assert.deepEqual(bin, cs.events.map((e) => [e[1] === 'close' ? 'fim' : e[1], e[2]]));
    // Lighter: mesma ancora, mesmo degrau, fita com os extremos na ordem do caminho -> mesmos preenchimentos e o mesmo resultado "nivel"
    const lig = evOf(dir, 'lighter').map((c) => [c[4], +c[5]]);
    assert.deepEqual(lig, cs.events.map((e) => [e[1] === 'close' ? 'fim' : e[1], e[2]]));
    assert.equal(a.nfL, cs.nf); assert.equal(a.gapMin, 0); assert.equal(a.parcial, false);
    if (!ref.stopOpen && safe) assert.ok(Math.abs(a.lvl / 1e4 - cs.pnl) < 1e-12, `nivel ${a.lvl} x ${cs.pnl * 1e4}`);
    // real: pernas a mercado no livro raso (US$5k varrendo niveis de US$2k a 0,1 bp) -> abaixo do "mid" so pelo custo das pernas
    const legs = (cs.halted ? 1 : 0) + (cs.events.some((e) => e[1] === 'close') ? 1 : 0);
    assert.ok(a.real <= a.mid + 1e-9 && a.mid - a.real <= legs * 0.3 + 1e-9, `real ${a.real} x mid ${a.mid} (${legs} pernas a mercado)`);
    if (legs) assert.ok(a.mid - a.real > 0.01, `a perna a mercado paga o livro (${a.mid - a.real} bp)`);
    assert.equal(d.cart.parcial, false);
  });
}

test('reinicio no meio da janela: o buraco vai pelos candles de 1m da Lighter e o resultado e o mesmo', async () => {
  const cs = cases.find((c) => c.nf >= 6 && !c.halted);
  const wb = winBars(cs);
  // reinicia num minuto sem evento, depois do 2o preenchimento
  const ev2 = cs.events.filter((e) => e[1] !== 'close')[1][0];
  let k = ev2 + 30;
  while (cs.events.some((e) => Math.abs(e[0] - k) <= 12)) k++;
  const { wg, dir, rest, safe } = await simulate(cs, { restartAt: wb[k].t });
  const a = wg.st.done.at(-1).assets[cs.sym];
  assert.ok(Math.abs(a.theo / 1e4 - cs.pnl) < 1e-12);
  assert.equal(a.gapMin, 10, '10 min parados');
  assert.deepEqual(rest.calls.map((c) => [c.from, c.to, c.res]), [[wb[k].t, wb[k].t + 10 * MIN, '1m']]);
  assert.deepEqual(evOf(dir, 'lighter').map((c) => [c[4], +c[5]]), cs.events.map((e) => [e[1] === 'close' ? 'fim' : e[1], e[2]]));
  if (safe) assert.ok(Math.abs(a.lvl / 1e4 - cs.pnl) < 1e-12);
  assert.equal(a.parcial, false);
});

test('app parado na abertura: ancora pelo candle das 17:00, horas cobertas por candles, fim de semana parcial', async () => {
  const cs = cases.find((c) => !c.halted && c.nf >= 3);
  const dir = tmp(), R = one(cs.sym), sh = fakeShadow(cs.sym), wb = winBars(cs);
  const rest = { calls: [], candles: async (id, from, to) => { rest.calls.push([from, to]); return wb.filter((b) => b.t >= from && b.t + MIN <= to); } };
  const wg = new WeekendGrid({ dataDir: dir, shadow: sh, rest, R, fetchJSON: fakeBinance(cs), gapMs: 0 });
  const t0 = cs.T0 + 20 * H + 30_000; // sobe no sabado
  sh.books.set(cs.sym, bookAt(wb[1200].c));
  await wg.tick(t0);
  const L = wg.st.cur.L[cs.sym];
  assert.equal(L.a, null); assert.equal(wg.st.cur.late, true);
  await wg.tick(t0 + 1000); // flush: sem negocio guardado e sem LiveBars -> cobre ate o inicio do buffer
  assert.equal(L.a, wb[0].o); assert.equal(L.src, 'candle');
  assert.equal(L.gapMin, 20 * 60);
  for (const b of wb.filter((x) => x.t >= cs.T0 + 20 * H + MIN)) for (const x of tape(b)) wg.onTrade(cs.sym, x);
  wg.onTrade(cs.sym, { timestamp: cs.T1 - 1, price: String(wb.at(-1).c), usd_amount: '1' });
  await wg.tick(cs.T1 + 5000); await wg.tick(cs.T1 + 6000);
  const d = wg.st.done.at(-1);
  assert.equal(d.assets[cs.sym].parcial, true); assert.equal(d.cart.parcial, true);
  assert.equal(wg.view().stats.n, 0); assert.equal(wg.view().stats.nAll, 1);
});

test('canal de negocios reinscrito: guarda os negocios novos e cobre o buraco com candles', async () => {
  const cs = cases[2];
  const dir = tmp(), R = one(cs.sym), live = { subAt: new Map([[cs.sym, 1]]) }, sh = fakeShadow(cs.sym, { live }), wb = winBars(cs);
  const rest = { calls: [], candles: async (id, from, to) => { rest.calls.push([from, to]); return wb.filter((b) => b.t >= from && b.t + MIN <= to); } };
  const wg = new WeekendGrid({ dataDir: dir, shadow: sh, rest, R, fetchJSON: fakeBinance(cs), gapMs: 0 });
  sh.books.set(cs.sym, bookAt(wb[0].o));
  wg.onTrade(cs.sym, { timestamp: cs.T0 - 5000, price: String(wb[0].o), usd_amount: '1' }); // antes da janela: so registra a inscricao
  await wg.tick(cs.T0 + 1000); await wg.tick(cs.T0 + 2000);
  const L = wg.st.cur.L[cs.sym];
  assert.equal(L.mode, 'live');
  for (const b of wb.slice(0, 100)) for (const x of tape(b)) wg.onTrade(cs.sym, x);
  live.subAt.set(cs.sym, 2); // caiu e voltou: negocios dos candles 100..104 perdidos
  for (const b of wb.slice(105, 110)) for (const x of tape(b)) wg.onTrade(cs.sym, x);
  assert.equal(L.mode, 'buffer');
  await wg.tick(wb[110].t + 1000);
  assert.equal(L.mode, 'live');
  assert.deepEqual(rest.calls, [[wb[100].t, wb[105].t]]);
  assert.equal(L.gapMin, 5);
});

test('stop varrendo o livro, fechamento no livro, funding e resultado em bp do capital', () => {
  const R = { ...GF, syms: ['ETH'], carteira: ['ETH'], custo: { ETH: 2e-4 } };
  const L = { sym: 'ETH', a: 100, g: 0.01, unit: R.capUSD / (R.J * 100), lvl: 0, pos: 0, cash: 0, nf: 0, halted: false, legs: [], fund: 0 };
  const lv = (k) => 100 * (1 + k * 0.01);
  // sobe: vende em 101, 102 e 103 so passando 1 bp do nivel; um negocio que pula dois niveis preenche os dois
  assert.deepEqual(gridTrade(L, 101.0102, null, R).map((e) => [e.side, e.k]), [['sell', 1]]);
  assert.deepEqual(gridTrade(L, 102.0, 101.0102, R), []); // encostou no nivel sem passar 1 bp
  assert.deepEqual(gridTrade(L, 103.0104, 102.0, R).map((e) => [e.side, e.k, e.px]), [['sell', 2, lv(2)], ['sell', 3, lv(3)]]);
  assert.equal(L.pos, -3); assert.equal(L.nf, 3);
  // 104 com a posicao cheia: stop (compra 3 unidades a mercado), referencia no nivel
  const st = gridTrade(L, 104.2, 103.0104, R);
  assert.deepEqual(st.map((e) => [e.side, e.k, e.qty, e.px]), [['stop', 4, 3, lv(4)]]);
  assert.equal(L.halted, true); assert.equal(L.pos, 0);
  assert.deepEqual(gridTrade(L, 90, 104.2, R), []); // parado ate o fim
  // livro: US$5k varrendo asks de 104,3 (US$2k) e 104,5 (US$10k)
  const b = new OrderBook('ETH');
  b.apply({ type: 'subscribed/order_book', order_book: { asks: [{ price: '104.3', size: String(2000 / 104.3) }, { price: '104.5', size: '100' }], bids: [{ price: '104.1', size: '100' }], nonce: 1 } });
  const coins = 3 * L.unit, sw = b.sweepQty('buy', coins);
  L.legs.push({ why: 'stop', qty: 3, lvl: 104, mid: 104.2, vwap: sw.avg });
  L.fund = -0.05; // pagou funding
  const r = lighterResult(L, R);
  const k = 1e4 / (3 * 100);
  assert.ok(Math.abs(r.lvl - (101 + 102 + 103 - 3 * 104 * (1 + 2e-4)) * k) < 1e-9);
  assert.ok(Math.abs(r.mid - (306 - 3 * 104.2) * k) < 1e-9);
  assert.ok(Math.abs(r.real - (306 - 3 * sw.avg) * k) < 1e-9);
  assert.ok(Math.abs(r.slip - (sw.avg / 104 - 1) * 1e4) < 1e-9 && r.slip > 30);
  assert.ok(Math.abs(r.fund - -0.05 * k) < 1e-12);
  // desce com buraco: o negocio anterior ja estava abaixo do stop -> referencia = o proprio negocio (como a abertura do candle)
  const D = { a: 100, g: 0.01, lvl: -3, pos: 3, cash: -294, nf: 3, halted: false };
  assert.deepEqual(gridTrade(D, 95.5, 95.9, R).map((e) => [e.side, e.k, e.qty, e.px]), [['stop', -4, -3, 95.5]]);
  const C = { a: 100, g: 0.01, lvl: -3, pos: 3, cash: -294, nf: 3, halted: false }; // sem buraco: referencia no nivel
  assert.deepEqual(gridTrade(C, 95.5, 96.3, R).map((e) => [e.side, e.k, e.qty, e.px]), [['stop', -4, -3, lv(-4)]]);
});

test('funding da Lighter aplicado a posicao do momento, uma vez por carimbo', async () => {
  const cs = cases[0];
  const dir = tmp(), R = one(cs.sym), sh = fakeShadow(cs.sym), wb = winBars(cs);
  const wg = new WeekendGrid({ dataDir: dir, shadow: sh, rest: { candles: async () => [] }, R, fetchJSON: fakeBinance(cs), gapMs: 0 });
  sh.books.set(cs.sym, bookAt(wb[0].o));
  await wg.tick(cs.T0 + 1000); await wg.tick(cs.T0 + 2000);
  const L = wg.st.cur.L[cs.sym];
  L.pos = -2;
  wg.onStats(cs.sym, { funding_timestamp: cs.T0 + H, funding_rate: '0.001', mark_price: '100' });
  wg.onStats(cs.sym, { funding_timestamp: cs.T0 + H, funding_rate: '0.001', mark_price: '100' }); // repetido: ignora
  assert.ok(Math.abs(L.fund - 2 * 100 * 0.001 / 100) < 1e-15); // vendido recebe com taxa positiva
  wg.onStats(cs.sym, { funding_timestamp: cs.T0 - H, funding_rate: '0.5', mark_price: '100' }); // antes da janela: ignora
  assert.ok(Math.abs(L.fund - 0.002) < 1e-15);
  wg.stop();
});
