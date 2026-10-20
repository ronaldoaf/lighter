// Fade C2: pre-filtro (lado, classe e custo antes do ranking) + top 2, comparado com o fade atual (top 1, filtra depois).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Strategy } from '../src/strategy.js';
import { OrderBook } from '../src/book.js';
import { BAR } from '../src/util.js';

const cfg = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url)));
const prior = (f) => new URL(`../data/${f}`, import.meta.url).pathname.replace(/^\/(\w:)/, '$1');

function book(sym, mid, bps) {
  const b = new OrderBook(sym);
  const lv = (k) => Array.from({ length: 20 }, (_, i) => ({ price: String(mid * (1 + k * bps * 1e-4 * (i + 1))), size: String(1e9 / mid) }));
  b.apply({ type: 'subscribed/order_book', order_book: { asks: lv(1), bids: lv(-1), nonce: 1 } });
  return b;
}

// A: maior corpo, mas barra de baixa (long desligado); B: alta, livro caro; C e D: alta, baratos; E: classe forex
const F = {
  A: { body: 4.0, vr: 5, liq: 2e6, dir: -1, hi4: 1, lo4: 0.9 },
  B: { body: 3.5, vr: 5, liq: 2e6, dir: 1, hi4: 1.1, lo4: 1 },
  E: { body: 3.2, vr: 5, liq: 2e6, dir: 1, hi4: 1.1, lo4: 1 },
  C: { body: 3.0, vr: 5, liq: 2e6, dir: 1, hi4: 1.1, lo4: 1 },
  D: { body: 2.0, vr: 5, liq: 2e6, dir: 1, hi4: 1.1, lo4: 1 },
};

function make(c2) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2-'));
  const books = new Map(Object.keys(F).map((s) => [s, book(s, 1, s === 'B' ? 50 : 1)]));
  const recorder = { books, markHot() {}, snapshot() {}, calmCost: () => NaN };
  const bars = { features: (sym) => F[sym] };
  const s = new Strategy({
    cfg: c2 ? { ...cfg.strategy, ...cfg.fadeC2.strategy } : cfg.strategy,
    sizing: c2 ? { ...cfg.sizing, ...cfg.fadeC2.sizing, kellyPriorFile: prior('kelly_prior_c2.json') } : { ...cfg.sizing, kellyPriorFile: prior('kelly_prior.json') },
    dataDir: dir, recorder, bars, live: { lastPx: new Map() }, classOf: (x) => (x === 'E' ? 'forex' : 'cripto'),
    name: 'C2', sub: c2 ? 'fade_c2' : null,
  });
  s.ready = true;
  return { s, dir };
}

test('fade atual: top 1 e barra de baixa -> nenhum setup', () => {
  const { s } = make(false);
  const k = Date.UTC(2026, 9, 7, 1, 0);
  s.now = () => k + BAR + 10_000;
  s.scan(k, Object.keys(F));
  assert.deepEqual(Object.keys(s.st.setups), []);
  assert.equal(s.st.signals[0].sym, 'A');
  assert.match(s.st.signals[0].reason, /long desligado/);
});

test('C2: pre-filtro descarta A (baixa), B (caro) e E (forex) e arma C e D', () => {
  const { s, dir } = make(true);
  const k = Date.UTC(2026, 9, 7, 1, 0);
  s.now = () => k + BAR + 10_000;
  s.scan(k, Object.keys(F));
  assert.deepEqual(Object.keys(s.st.setups).sort(), ['C', 'D']);
  assert.ok(fs.existsSync(path.join(dir, 'fade_c2', 'state.json')), 'estado na pasta propria');
  assert.ok(Math.abs(s.riskFrac - 0.3333 * s.kellyFull) < 1e-9 && s.riskFrac > 0.03 && s.riskFrac < 0.035, `risco ${s.riskFrac}`);
});
