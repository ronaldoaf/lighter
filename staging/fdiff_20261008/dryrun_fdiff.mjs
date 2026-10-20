// Ensaio ao vivo na VPS: decisao do diferencial de funding num horario ja passado, com as APIs reais e os candles do app (so leitura).
// Estado num diretorio temporario; nao toca no app. Uso: node dryrun_fdiff.mjs [T ISO]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const S = '/root/lighter/staging/fdiff_20261008/src';
const { Rest, classify } = await import(`${S}/rest.js`);
const { BarStore } = await import(`${S}/bars.js`);
const { FundingDiff } = await import(`${S}/fdiff.js`);
const H = 3_600_000;
const cfg = JSON.parse(fs.readFileSync('/root/lighter/config.json'));
const rest = new Rest(cfg.rest, { concurrency: 2, minGapMs: 200 });
const [mk, tokens] = await Promise.all([rest.markets(), rest.tokenlist()]);
const tok = new Map(tokens.map((t) => [t.symbol, t]));
const classOf = (s) => classify(tok.get(s));
const bars = new BarStore(rest, '/root/lighter/data', { sub: 'bars' }); // so load(): nunca refresh/save
const h1 = (s) => { try { return JSON.parse(fs.readFileSync(`/root/lighter/data/bars_1h/${s}.json`)); } catch { return []; } };
const fd = new FundingDiff({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fd-dry-')), rest, bars, trend: { load: h1 }, recorder: { books: new Map() },
  live: null, classOf, markets: () => mk });
const T = process.argv[2] ? Date.parse(process.argv[2]) : Math.floor(Date.now() / (6 * H)) * 6 * H;
const t0 = Date.now();
const snap = await fd.snapshot(T, Date.now());
const ann = (x) => (x * 365 * 24 / 168 * 100).toFixed(1).padStart(7) + '%';
console.log(`T ${new Date(T).toISOString()} | ${mk.filter((m) => classOf(m.symbol) === 'cripto').length} perps cripto | universo ${snap.univ.length} | n ${snap.n} | ${((Date.now() - t0) / 1000).toFixed(0)}s | REST ${rest.calls} chamadas, ${rest.errors} erros`);
console.log('compra:', snap.long.join(', '), '| vende:', snap.short.join(', '));
const u = [...snap.univ].sort((a, b) => b.s - a.s);
for (const x of [...u.slice(0, 6), { sym: '...' }, ...u.slice(-6)]) console.log(x.s === undefined ? '  ...' : `  ${x.sym.padEnd(10)} ${x.bsym.padEnd(16)} fd7 ${ann(x.s)} | Lighter ${ann(x.fl)} | Binance ${ann(x.fb)} | carimbos ${x.nl} | vol24 ${(x.vol24 / 1e6).toFixed(1)}M`);
console.log('carimbos Lighter na janela: 168 em', u.filter((x) => x.nl === 168).length, 'de', u.length, '| sem 168:', u.filter((x) => x.nl !== 168).map((x) => `${x.sym}:${x.nl}`).join(' ') || '-');
const errs = [...fd.fl.entries()].filter(([, c]) => c.err).map(([s, c]) => `${s}: ${c.err}`).concat([...fd.fb.entries()].filter(([, c]) => c.err).map(([s, c]) => `${s}: ${c.err}`));
console.log('erros de funding:', errs.length ? errs.join('; ') : 'nenhum');
