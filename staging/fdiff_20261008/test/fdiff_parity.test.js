// Paridade do diferencial de funding (src/fdiff.js) com o backtest (scripts/export_fdiff_cases.py -> test/fdiff_cases.json).
// Precisa de rede: candles 15m/1h e funding da Lighter (REST), funding e lista de perps da Binance (fapi). Cache em data/test_tmp.
// Confere, em cada decisao: universo, perp da Binance, funding das duas bolsas (descontando os carimbos que faltam no download do
// backtest), comprados e vendidos.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Rest, classify } from '../src/rest.js';
import { BarStore } from '../src/bars.js';
import { FundingDiff, pick } from '../src/fdiff.js';
import { BAR } from '../src/util.js';

const MIN = 60_000, DAY = 86_400_000;
const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json')));
const { cases, panel } = JSON.parse(fs.readFileSync(path.join(root, 'test', 'fdiff_cases.json')));

const rest = new Rest(cfg.rest, { concurrency: 3, minGapMs: 100 });
const [ob, tokens] = await Promise.all([rest.get('orderBooks'), rest.tokenlist()]);
// so os perps do painel do backtest (tambem os inativos hoje); os listados depois da montagem do painel mudariam o universo
const mk = ob.order_books.filter((o) => o.market_type === 'perp' && panel.includes(o.symbol));
const tok = new Map(tokens.map((t) => [t.symbol, t]));
const classOf = (s) => classify(tok.get(s));
const crypto = mk.filter((m) => classOf(m.symbol) === 'cripto');
const T0 = Math.min(...cases.map((c) => c.T)), T1 = Math.max(...cases.map((c) => c.T));
const dataDir = path.join(root, 'data', 'test_tmp');
const bars = new BarStore(rest, dataDir, { sub: 'fdiff_bars', keep: 1500, warm: Math.ceil((T1 - T0) / BAR) + 3 * 96 });
await bars.refresh(crypto, T1);
// candles 1h desde 25 dias antes do primeiro caso (idade >= 14 dias), em cache no disco
const h1File = path.join(dataDir, 'fdiff_h1.json');
let h1 = new Map(fs.existsSync(h1File) ? JSON.parse(fs.readFileSync(h1File)) : []);
if (h1.get('_janela')?.join() !== [T0, T1].join()) {
  h1 = new Map([['_janela', [T0, T1]]]);
  await Promise.all(crypto.map(async (m) => h1.set(m.symbol, await rest.candles(m.market_id, T0 - 25 * DAY, T1, '1h'))));
  fs.writeFileSync(h1File, JSON.stringify([...h1]));
}
const fd = new FundingDiff({ dataDir, rest, bars, trend: { load: (s) => h1.get(s) ?? [] }, recorder: { books: new Map() }, live: null,
  classOf, markets: () => mk });
// aquece o funding em memoria pela ultima e pela primeira decisao (depois quase nao ha pedidos)
await fd.snapshot(T1, T1 + 2 * MIN);
await fd.snapshot(T0, T0 + 2 * MIN);

for (const c of cases) {
  test(`fdiff ${c.iso}`, async () => {
    const snap = await fd.snapshot(c.T, c.T + 2 * MIN);
    const js = new Map(snap.univ.map((u) => [u.sym, u])), py = new Map(c.univ.map((u) => [u.sym, u]));
    const why = (s) => JSON.stringify(c.near.find((x) => x.sym === s) ?? py.get(s) ?? js.get(s));
    const onlyJs = [...js.keys()].filter((s) => !py.has(s)), onlyPy = [...py.keys()].filter((s) => !js.has(s));
    assert.deepEqual(onlyJs, [], `so no JS: ${onlyJs.map(why).join(' ')}`);
    assert.deepEqual(onlyPy, [], `so no Python: ${onlyPy.map(why).join(' ')}`);
    for (const [s, p] of py) {
      const j = js.get(s), miss = p.missL.reduce((a, t) => a + (fd.fl.get(s)?.recs.get(t) ?? 0), 0);
      assert.equal(j.bsym, p.bsym, s);
      assert.ok(Math.abs(j.fl - miss - p.fl) < 1e-12, `${s} Lighter: js ${j.fl} (faltam ${p.missL.length}: ${miss}) py ${p.fl}`);
      assert.ok(Math.abs(j.fb - p.fb) < 1e-12, `${s} Binance: js ${j.fb} py ${p.fb}`);
      assert.ok(Math.abs(j.vol24 - p.vol24) <= 1e-6 * p.vol24, `${s} vol24: js ${j.vol24} py ${p.vol24}`);
    }
    // selecao com o sinal do backtest (sem os carimbos que faltam no download) e com o sinal completo da API
    const adj = pick(snap.univ.map((u) => ({ sym: u.sym, s: u.s - (py.get(u.sym)?.missL ?? []).reduce((a, t) => a + (fd.fl.get(u.sym)?.recs.get(t) ?? 0), 0) })));
    assert.deepEqual([...adj.long].sort(), [...c.long].sort(), 'comprados');
    assert.deepEqual([...adj.short].sort(), [...c.short].sort(), 'vendidos');
    if (adj.long.join() !== snap.long.join() || adj.short.join() !== snap.short.join()) console.log(`${c.iso}: com o funding completo a selecao muda`, snap.long, snap.short);
  });
}
