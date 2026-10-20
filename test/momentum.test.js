// Paridade do momentum (src/momentum.js) com o backtest Python (scripts/export_momentum_prior.py -> test/momentum_cases.json).
// Baixa (ou atualiza) o historico longo em data/bars_mom pelo mesmo BarStore do app (precisa de rede).
// Confere so os casos cuja janela de 30d de vol esta inteira no cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Rest, classify } from '../src/rest.js';
import { BarStore } from '../src/bars.js';
import { Momentum } from '../src/momentum.js';
import { BAR } from '../src/util.js';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json')));
const { universe, cases } = JSON.parse(fs.readFileSync(path.join(root, 'test', 'momentum_cases.json')));

const rest = new Rest(cfg.rest, { concurrency: 3, minGapMs: 100 });
const [mk, tokens] = await Promise.all([rest.markets(), rest.tokenlist()]);
const tok = new Map(tokens.map((t) => [t.symbol, t]));
const cls = new Map(mk.map((m) => [m.symbol, classify(tok.get(m.symbol))]));
const bars = new BarStore(rest, path.join(root, cfg.dataDir), { sub: 'bars_mom', keep: 3600, warm: 3600 });
const T0 = Math.floor(Date.now() / BAR) * BAR;
await bars.refresh(mk.filter((m) => cls.get(m.symbol) === 'cripto'), T0);
const mom = new Momentum({ cfg: { ...cfg.momentum, priorFile: path.join(root, cfg.momentum.priorFile) }, dataDir: path.join(root, 'data', 'test_tmp'),
  recorder: { books: new Map() }, bars, live: { lastPx: new Map() }, classOf: (s) => cls.get(s) ?? 'cripto', markets: () => mk });
// so os perps cripto que existem no painel do backtest (os listados depois mudariam o ranking)
const syms = mk.filter((m) => cls.get(m.symbol) === 'cripto' && universe.includes(m.symbol)).map((m) => m.symbol);
const first = T0 - 3600 * BAR; // inicio da janela do cache (ativos listados depois comecam mais tarde, como no painel)
const missing = universe.filter((s) => !syms.includes(s) || !bars.load(s).length);
if (missing.length) console.log('fora do cache/mercado:', missing.join(' '));

for (const c of cases) {
  const k = c.t - BAR;
  const covered = k - (cfg.momentum.volDays * 96 + 1) * BAR >= first;
  test(`momentum ${new Date(c.t).toISOString().slice(0, 10)}`, { skip: !covered && 'janela de 30d fora do cache' }, () => {
    const tg = mom.target(k, syms);
    const py = Object.keys(c.elig).sort(), js = Object.keys(tg.elig).sort();
    assert.deepEqual(js.filter((s) => !py.includes(s)), [], 'elegiveis so no JS');
    assert.deepEqual(py.filter((s) => !js.includes(s)), [], 'elegiveis so no Python');
    for (const s of py) {
      for (const f of ['r', 'vol', 'liq', 'key']) {
        const a = tg.elig[s][f], b = c.elig[s][f];
        assert.ok(Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)), `${s}.${f}: js ${a} py ${b}`);
      }
    }
    assert.deepEqual([...tg.long].sort(), [...c.long].sort(), 'comprados');
    assert.deepEqual([...tg.short].sort(), [...c.short].sort(), 'vendidos');
  });
}
