// Quad em turbulencia (src/quadturb.js): paridade com a referencia scripts/quadturb.py em janelas reais de 1m da Binance
// (scripts/export_quadturb_cases.py -> test/quadturb_cases.json.gz) e a logica de decisao do modo sombra (sem rede).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { QTCalc, QuadTurb, QT, RollMean, etMinute } from '../src/quadturb.js';

const MIN = 60_000, H = 3_600_000;
const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const { params, cases } = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root, 'test', 'quadturb_cases.json.gz'))).toString());
const bar = (x) => ({ t: x[0], o: x[1], h: x[2], l: x[3], c: x[4], v: x[5] });
const same = (a, b) => (b === null ? !Number.isFinite(a) : a === b);

test('parametros iguais aos da referencia', () => {
  assert.equal(QT.nivel, params.nivel); assert.equal(QT.thr, params.thr); assert.equal(QT.win, params.win); assert.equal(QT.minp, params.minp);
  assert.equal(QT.hold, params.H); assert.equal(QT.perda, params.perda); assert.equal(QT.janelaH, params.janela_h); assert.equal(QT.pausaH, params.pausa_h);
});

test('minuto de NY (EDT e EST)', () => {
  assert.equal(etMinute(Date.parse('2026-10-07T12:30:00Z')), 8 * 60 + 30);  // EDT
  assert.equal(etMinute(Date.parse('2026-12-07T13:31:00Z')), 8 * 60 + 31);  // EST
  assert.equal(etMinute(Date.parse('2026-12-08T04:59:00Z')), 23 * 60 + 59);
  assert.equal(etMinute(Date.parse('2026-12-08T05:00:00Z')), 0);
});

test('RollMean: valores iguais em sequencia devolvem o proprio valor', () => {
  const r = new RollMean(3, 3);
  for (const v of [0.1, 0.2, 0.3, 20, 20, 20]) r.push(v);
  assert.equal(r.out, 20);
});

for (const cs of cases) {
  test(`paridade bit a bit dos indicadores e sinais: ${cs.sym} ${cs.start}..${cs.end}`, () => {
    const calc = new QTCalc(QT), res = [], sig = [];
    for (const x of cs.bars) { const r = calc.push(bar(x)); res.push(r); if (r.sig) sig.push(r.t); }
    let bad = 0;
    for (const e of cs.expected) {
      const r = res[e.i];
      const ok = e.d.every((v, k) => same(r.d[k], v)) && same(r.atrBp, e.atr_bp) && same(r.rel, e.rel) && r.quad === e.quad && r.ok === e.ok && r.sig === e.sig;
      if (!ok && bad++ < 3) console.log('diferenca', cs.sym, e.i, new Date(r.t).toISOString(), { js: { d: r.d, atr: r.atrBp, rel: r.rel, quad: r.quad, ok: r.ok, sig: r.sig }, py: e });
    }
    assert.equal(bad, 0, `${bad} de ${cs.expected.length} pontos diferentes`);
    assert.deepEqual(sig, cs.signals);
  });
}

/** sombra falsa: abre ao preco de fechamento da Binance da barra corrente e fecha no horario (tick antes de cada barra) */
function fakeShadow() {
  const sh = { st: { pos: [], closed: [] }, nextId: 1, now: 0, px: new Map(), saved: 0 };
  sh.open = (strat, sym, d, { exitAt, info }) => {
    if (sh.st.pos.some((p) => p.strat === strat && p.sym === sym)) return null;
    const p = { id: sh.nextId++, strat, sym, d, exitAt, info, openTs: sh.now, midIn: sh.px.get(sym) };
    sh.st.pos.push(p); return p;
  };
  sh.close = (p, why) => {
    sh.st.pos = sh.st.pos.filter((x) => x !== p);
    sh.st.closed.push({ strat: p.strat, sym: p.sym, id: p.id, why, openTs: p.openTs, closeTs: sh.now, bp_mid: (sh.px.get(p.sym) / p.midIn - 1) * 1e4 });
  };
  sh.tick = () => { for (const p of [...sh.st.pos]) if (p.exitAt && sh.now >= p.exitAt) sh.close(p, 'tempo'); };
  sh.save = () => { sh.saved++; };
  return sh;
}

for (const cs of cases) {
  test(`simulacao ao vivo reproduz os trades da referencia (saida em 60 min, uma posicao por ativo, disjuntor): ${cs.sym}`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qt-'));
    const sh = fakeShadow();
    const qt = new QuadTurb({ dataDir: dir, shadow: sh, fetchJSON: async () => { throw new Error('sem rede no teste'); } });
    qt.calc.set(cs.sym, new QTCalc(QT)); qt.bsym.set(cs.sym, cs.sym + 'USDT');
    for (const x of cs.bars) {
      const b = bar(x);
      sh.now = b.t + MIN + 3000; sh.px.set(cs.sym, b.c);
      sh.tick();
      qt.onBar(cs.sym, b, sh.now);
    }
    const got = sh.st.closed.map((t) => ({ t_in: t.openTs - MIN - 3000, t_out: t.closeTs - MIN - 3000, ret: t.bp_mid / 1e4 }));
    assert.equal(got.length, cs.trades.length, `trades: js ${got.length} x referencia ${cs.trades.length}`);
    got.forEach((g, k) => {
      const e = cs.trades[k];
      assert.equal(g.t_in, e.t_in); assert.equal(g.t_out, e.t_out);
      assert.ok(Math.abs(g.ret - e.ret) < 1e-12, `${g.ret} x ${e.ret}`);
    });
    // resultado teorico (Binance, 60 barras) igual ao da sombra falsa
    const done = qt.st.done.filter((d) => d.sym === cs.sym);
    assert.equal(done.length, got.length);
    done.forEach((d, k) => assert.ok(Math.abs(d.bp / 1e4 - got[k].ret) < 1e-12));
    // todo sinal da referencia aparece no signals.csv (aberto ou com motivo)
    const lines = fs.readFileSync(path.join(dir, 'shadow', 'quad_turb', 'signals.csv'), 'utf8').trim().split('\n');
    assert.equal(lines.length - 1, cs.signals.length);
  });
}

test('disjuntor: perda de 10% em 24h pausa o ativo por 72h; posicao aberta e sinal atrasado nao abrem', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qt-'));
  const sh = fakeShadow();
  const qt = new QuadTurb({ dataDir: dir, shadow: sh, fetchJSON: async () => [] });
  const t0 = Date.parse('2026-10-10T01:00:00Z');
  const r = (t) => ({ t, c: 100, d: [10, 10, 10, 10], atrBp: 30, rel: 3, quad: true, ok: true, sig: true });
  sh.px.set('SOL', 100); sh.now = t0 + MIN + 3000;
  qt.onSignal('SOL', r(t0), sh.now);
  assert.equal(sh.st.pos.length, 1);
  qt.onSignal('SOL', r(t0 + 5 * MIN), t0 + 6 * MIN + 3000); // ja posicionado
  assert.equal(sh.st.pos.length, 1);
  assert.equal(qt.st.sigs[0].why, 'já posicionado no ativo');
  sh.now = t0 + 61 * MIN + 3000; sh.px.set('SOL', 89); sh.tick(); // -11%
  assert.equal(sh.st.closed.length, 1);
  qt.onSignal('SOL', r(t0 + 70 * MIN), t0 + 71 * MIN + 3000);
  assert.equal(sh.st.pos.length, 0);
  assert.match(qt.st.sigs[0].why, /^disjuntor: -11\.0%/);
  const until = qt.st.pause.SOL;
  assert.equal(until, t0 + 71 * MIN + 3000 + 72 * H);
  qt.onSignal('SOL', r(t0 + 30 * H), t0 + 30 * H + MIN + 3000); // 24h depois a perda saiu da janela, mas a pausa continua
  assert.match(qt.st.sigs[0].why, /^disjuntor até/);
  sh.px.set('SOL', 95);
  qt.onSignal('SOL', r(t0 + 80 * H), t0 + 80 * H + MIN + 3000); // depois da pausa
  assert.equal(sh.st.pos.length, 1);
  qt.onSignal('ETH', r(t0 + 80 * H), t0 + 80 * H + 10 * MIN); // barra de 9 minutos atras
  assert.equal(qt.st.sigs[0].why, 'atrasado (barra antiga)');
});

test('aquecimento e atualizacao com a API falsa da Binance (pula barra sem volume e a barra ainda aberta)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qt-'));
  const sh = fakeShadow();
  const cs = cases[0];
  const now = cs.bars.at(-1)[0] + MIN + 3000;
  const R = { ...QT, syms: [cs.sym] };
  const all = cs.bars.map((x) => [x[0], String(x[1]), String(x[2]), String(x[3]), String(x[4]), String(x[5])]);
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const qt = new QuadTurb({ dataDir: dir, shadow: sh, R, gapMs: 0, fetchJSON: async (url) => {
      const u = new URL(url), st = +u.searchParams.get('startTime') || 0, lim = +u.searchParams.get('limit');
      const xs = all.filter((x) => x[0] >= st);
      return st ? xs.slice(0, lim) : all.slice(-lim);
    } });
    await qt.warmAll();
    assert.equal(qt.calc.get(cs.sym).n, cs.bars.length);
    assert.equal(qt.lastT.get(cs.sym), cs.bars.at(-1)[0]);
    await qt.updateAll(now); // nada novo
    assert.equal(qt.calc.get(cs.sym).n, cs.bars.length);
  } finally { Date.now = realNow; }
});

test('Lighter parada: nao abre sem negocio recente e adia a saida ate o livro voltar', async () => {
  const { Shadow } = await import('../src/shadow.js');
  const { OrderBook } = await import('../src/book.js');
  const book = (mid) => {
    const b = new OrderBook('x');
    const lv = (k) => Array.from({ length: 20 }, (_, i) => ({ price: String(mid * (1 + k * 1e-4 * (i + 1))), size: String(1e9 / mid) }));
    b.apply({ type: 'subscribed/order_book', order_book: { asks: lv(1), bids: lv(-1), nonce: 1 } });
    return b;
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qt-'));
  const books = new Map([['SOL', book(100)]]);
  const live = { lastPx: new Map(), subAt: new Map(), lastTs: new Map() };
  const sh = new Shadow({ dataDir: dir, recorder: { books, markHot() {}, calmCost: () => 0.0001 }, bars: { features: () => ({ liq: 1e6 }) }, live,
    classOf: () => 'cripto', markets: () => [{ symbol: 'SOL' }], trend: { load: () => [], view: () => ({ rows: [] }) }, momentum: null, fades: [] });
  sh.ready = true; sh.fetchEarnings = async () => []; sh.resPause = 0;
  const qt = sh.qt;
  const t0 = Date.parse('2026-10-10T01:00:00Z'), now = t0 + MIN + 3000;
  const r = { t: t0, c: 100, d: [10, 10, 10, 10], atrBp: 30, rel: 3, quad: true, ok: true, sig: true };
  live.lastTs.set('SOL', now - 6 * MIN);
  qt.onSignal('SOL', r, now);
  assert.equal(sh.st.pos.length, 0);
  assert.match(qt.st.sigs[0].why, /^Lighter sem negócio/);
  live.lastTs.set('SOL', now - 10_000);
  qt.onSignal('SOL', { ...r, t: t0 + MIN }, now + MIN);
  assert.equal(sh.st.pos.length, 1);
  const p = sh.st.pos[0];
  assert.equal(p.exitAt, t0 + 2 * MIN + 60 * MIN);
  sh.tick(p.exitAt + 2000); // ultimo negocio ha mais de 5 min: adia
  assert.equal(sh.st.pos.length, 1);
  assert.ok(p.waitSince);
  books.set('SOL', book(103)); live.lastTs.set('SOL', p.exitAt + 20 * MIN);
  sh.tick(p.exitAt + 20 * MIN + 1000);
  assert.equal(sh.st.pos.length, 0);
  const c = sh.st.closed.at(-1);
  assert.equal(c.why, 'tempo (adiado: Lighter parada)');
  assert.ok(Math.abs(c.bp_mid - 300) < 1e-6, c.bp_mid);
  sh.qt.stop?.();
});
