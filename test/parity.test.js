// Paridade com o backtest: casos exportados por scripts/export_parity_cases.py (trades reais do motor Python).
// Para cada caso: medidas do sinal iguais, e o replay das barras como negocios gera a mesma entrada e saida.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BarStore, LiveBars } from '../src/bars.js';
import { Strategy } from '../src/strategy.js';
import { OrderBook } from '../src/book.js';
import { BAR } from '../src/util.js';

const cases = JSON.parse(fs.readFileSync(new URL('./parity_cases.json', import.meta.url)));
const cfg = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url)));
const close = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

function deepBook(sym, mid) {
  const b = new OrderBook(sym);
  const lv = (k) => Array.from({ length: 20 }, (_, i) => ({ price: String(mid * (1 + k * 0.0001 * (i + 1))), size: String(1e9 / mid) }));
  b.apply({ type: 'subscribed/order_book', order_book: { asks: lv(1), bids: lv(-1), nonce: 1 } });
  return b;
}

function harness(c) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-'));
  const bars = new BarStore(null, dir);
  bars.bars.set(c.sym, c.bars);
  const books = new Map();
  const recorder = { books, markHot() {}, snapshot() {}, calmCost: () => NaN };
  let strategy;
  const live = new LiveBars((sym, bar, t, complete) => strategy.onBar(sym, bar, t, complete));
  live.subAt.set(c.sym, 0);
  strategy = new Strategy({ cfg: cfg.strategy, sizing: { ...cfg.sizing, kellyPriorFile: new URL('../data/kelly_prior.json', import.meta.url).pathname.replace(/^\/(\w:)/, '$1') },
    dataDir: dir, recorder, bars, live, classOf: () => 'cripto' });
  strategy.ready = true;
  return { strategy, live, books, bars };
}

for (const c of cases) {
  test(`${c.sym} sinal ${new Date(c.k).toISOString()}`, () => {
    const { strategy, live, books, bars } = harness(c);
    const f = bars.features(c.sym, c.k);
    assert.ok(close(f.body, c.body, 1e-6), `corpo ${f.body} vs ${c.body}`);
    assert.ok(close(f.vr, c.vr, 1e-6), `vr ${f.vr} vs ${c.vr}`);
    assert.ok(close(f.liq, c.liq, 1e-6), `liq ${f.liq} vs ${c.liq}`);

    const kbar = c.bars.find((b) => b.t === c.k);
    books.set(c.sym, deepBook(c.sym, kbar.c));
    strategy.now = () => c.k + BAR + 10_000;
    strategy.scan(c.k, [c.sym]);
    assert.ok(strategy.st.setups[c.sym], `setup criado: ${strategy.st.signals[0]?.reason}`);

    // replay: cada barra vira 4 negocios. Sem posicao: o, l, h, c (o rompimento vem antes da maxima, que o backtest
    // confere contra o stop na barra de entrada). Com posicao: o, h, l, c (stop antes do alvo, como o backtest).
    for (const b of c.bars.filter((x) => x.t > c.k)) {
      const pos = strategy.st.positions[c.sym];
      const seq = pos && b.t > pos.fillBar ? [b.o, b.h, b.l, b.c] : [b.o, b.l, b.h, b.c];
      seq.forEach((px, i) => {
        const ts = b.t + 1000 * (i + 1);
        const r = live.trade(c.sym, px, ts, 0);
        if (r) strategy.onTrade(c.sym, px, ts, r.t, r.first);
      });
      if (strategy.st.closed.length) break;
    }
    live.tick(c.bars.at(-1).t + 2 * BAR);

    const tr = strategy.st.closed[0];
    assert.ok(tr, `trade fechado (setups: ${JSON.stringify(Object.keys(strategy.st.setups))}, sinal: ${strategy.st.signals[0]?.reason})`);
    assert.ok(close(tr.E, c.E), `E ${tr.E} vs ${c.E}`);
    assert.ok(close(tr.stop, c.stop), `stop ${tr.stop} vs ${c.stop}`);
    assert.ok(close(tr.tgt, c.tgt), `alvo ${tr.tgt} vs ${c.tgt}`);
    assert.equal(tr.why, c.why);
    assert.ok(close(tr.exit_theo, c.px), `saida ${tr.exit_theo} vs ${c.px}`);
    const xbar = tr.why === 'timeout' ? tr.exit_ts - BAR : Math.floor(tr.exit_ts / BAR) * BAR;
    assert.equal(xbar, c.kx, 'barra de saida');
  });
}
