import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BAR, barStart, log, readJSON, ensureDir } from './util.js';
import { Rest, classify } from './rest.js';
import { WsPool } from './ws.js';
import { Recorder } from './recorder.js';
import { BarStore, LiveBars } from './bars.js';
import { Strategy } from './strategy.js';
import { Momentum } from './momentum.js';
import { TrendBoard } from './trend.js';
import { Shadow } from './shadow.js';
import { startServer } from './server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);
const cfg = readJSON(path.join(ROOT, 'config.json'));
const dataDir = ensureDir(path.resolve(ROOT, cfg.dataDir));

const rest = new Rest(cfg.rest, { concurrency: 3, minGapMs: 100 });
const app = { cfg, status: 'iniciando', startedAt: Date.now(), markets: [], bySym: new Map(), byId: new Map(), cls: new Map() };

async function loadMarkets() {
  const [mk, tokens] = await Promise.all([rest.markets(), rest.tokenlist().catch(() => [])]);
  const tok = new Map(tokens.map((t) => [t.symbol, t]));
  for (const m of mk) {
    if (!app.bySym.has(m.symbol)) app.markets.push(m);
    app.bySym.set(m.symbol, m); app.byId.set(String(m.market_id), m);
    app.cls.set(m.symbol, classify(tok.get(m.symbol)));
  }
  return mk;
}
const classOf = (sym) => app.cls.get(sym) ?? 'cripto';

async function main() {
  await loadMarkets();
  const count = {};
  for (const c of app.cls.values()) count[c] = (count[c] || 0) + 1;
  log('INFO', `${app.markets.length} perps ativos`, count);

  const recorder = new Recorder(cfg.recorder, dataDir, classOf);
  const bars = new BarStore(rest, dataDir);
  let strategy, strategyC2;
  const live = new LiveBars((sym, bar, t, complete) => { strategy?.onBar(sym, bar, t, complete); strategyC2?.onBar(sym, bar, t, complete); });
  strategy = new Strategy({ cfg: cfg.strategy, sizing: cfg.sizing, dataDir, recorder, bars, live, classOf });
  // fade C2 em paralelo (capital e estado proprios em data/fade_c2): config do fade + sobrescritas de cfg.fadeC2
  const c2 = cfg.fadeC2;
  strategyC2 = c2?.enabled ? new Strategy({ cfg: { ...cfg.strategy, ...c2.strategy }, sizing: { ...cfg.sizing, ...c2.sizing },
    dataDir, recorder, bars, live, classOf, name: 'C2', sub: 'fade_c2' }) : null;
  const fades = [strategy, strategyC2].filter(Boolean);
  // momentum 14d: historico longo (30d de vol + 7d de metas) so dos perps cripto, em cache separado
  const mbars = new BarStore(rest, dataDir, { sub: 'bars_mom', keep: 3600, warm: 3600 });
  const momentum = cfg.momentum?.enabled ? new Momentum({ cfg: cfg.momentum, dataDir, recorder, bars: mbars, live, classOf, markets: () => app.markets }) : null;
  const trend = new TrendBoard({ rest, dataDir, classOf, markets: () => app.markets, bars15: bars }); // 15m do fade + 1h proprio
  // modo sombra: candidatos sem capital (data/shadow); usa so dados que o app ja recebe (+ 1 kline da Binance por sinal do fade)
  const shadow = cfg.shadow?.enabled === false ? null : new Shadow({ dataDir, recorder, bars, live, classOf, markets: () => app.markets, trend, momentum, fades });
  Object.assign(app, { recorder, bars, live, strategy, strategyC2, momentum, trend, rest, shadow });

  const server = startServer(cfg.port, app, cfg.host);

  // WebSocket: livro + negocios de todos os perps, funding/mark de todos
  const ws = new WsPool(cfg.ws, {
    connections: 3,
    onMessage: (name, id, m) => {
      if (name === 'market_stats') {
        const all = m.market_stats || {};
        for (const s of (all.symbol ? [all] : Object.values(all))) { recorder.onStats(s.symbol, s); for (const f of fades) f.onStats(s.symbol, s); momentum?.onStats(s.symbol, s); shadow?.onStats(s.symbol, s); }
        return;
      }
      const mk = app.byId.get(id);
      if (!mk) return;
      const sym = mk.symbol;
      if (name === 'order_book') {
        if (!recorder.book(sym).apply(m)) {
          log('AVISO', `${sym}: livro com nonce quebrado, reinscrevendo`);
          ws.resubscribe(`order_book/${id}`);
        }
      } else if (name === 'trade') {
        if (m.type === 'subscribed/trade') return live.subscribed(sym); // historico recente: ignorado
        const seen = new Set();
        const xs = [...(m.trades || []), ...(m.liquidation_trades || [])]
          .filter((x) => !seen.has(x.trade_id) && seen.add(x.trade_id))
          .sort((a, b) => a.timestamp - b.timestamp);
        for (const x of xs) {
          recorder.trade(sym, x);
          shadow?.onTrade(sym, x);
          const r = live.trade(sym, +x.price, x.timestamp, +x.usd_amount);
          if (r) for (const f of fades) f.onTrade(sym, +x.price, x.timestamp, r.t, r.first);
        }
      }
    },
    onReset: (ch) => {
      const [name, id] = ch.split('/');
      const sym = app.byId.get(id)?.symbol;
      if (!sym) return;
      if (name === 'order_book') recorder.book(sym).reset();
      if (name === 'trade') {
        live.subAt.delete(sym);
        const b = live.cur.get(sym);
        if (b) b.complete = false; // negocios perdidos durante a queda
      }
    },
  });
  app.ws = ws;
  const subscribeAll = () => {
    for (const m of app.markets) {
      ws.subscribe(`order_book/${m.market_id}`);
      ws.subscribe(`trade/${m.market_id}`);
    }
  };
  ws.subscribe('market_stats/all');
  subscribeAll();
  ws.start();
  recorder.start();

  // historico de candles (aquecimento: 700 barras = 7 dias para a liquidez)
  app.status = 'baixando historico de candles';
  log('INFO', 'aquecendo historico de candles 15m (REST)...');
  const fails = await bars.refresh(app.markets, barStart(Date.now()));
  log('INFO', `historico pronto em ${(bars.refreshMs / 1000).toFixed(0)}s (${fails} falhas)`);
  for (const f of fades) f.recover();
  shadow?.start();
  app.status = 'rodando';
  momentum?.start().catch((e) => log('ERRO', `momentum: ${e.stack}`)); // em paralelo, nao atrasa o fade
  trend.start().catch((e) => log('ERRO', `tendencia: ${e.stack}`));

  // relogio: fecha barras ao vivo e roda o sinal na virada de cada barra de 15m
  let lastClose = barStart(Date.now()), scanning = false;
  setInterval(async () => {
    const now = Date.now();
    if (now - barStart(now) >= 1500) live.tick(now);
    const cur = barStart(now);
    if (cur > lastClose && now - cur >= cfg.strategy.barCloseDelaySec * 1000 && !scanning) {
      lastClose = cur; scanning = true;
      const k = cur - BAR;
      try {
        const f = await bars.refresh(app.markets, cur);
        const have = app.markets.filter((m) => bars.load(m.symbol).at(-1)?.t === k).length;
        log('INFO', `barra ${new Date(k).toISOString().slice(11, 16)} fechada: candles em ${(bars.refreshMs / 1000).toFixed(0)}s, ${have}/${app.markets.length} com a barra, ${f} falhas`);
        for (const f of fades) {
          try { f.scan(k, app.markets.map((m) => m.symbol)); f.markCurve(); f.save(); }
          catch (e) { log('ERRO', `${f.tag}scan: ${e.stack}`); }
        }
        shadow?.onFadeScan(k).catch((e) => log('ERRO', `sombra fade: ${e.stack}`));
        if (momentum?.ready) { await momentum.onBarClose(cur); momentum.markCurve(); momentum.save(); }
        try { shadow?.onMomentum(cur); shadow?.onBarClose(cur); } catch (e) { log('ERRO', `sombra: ${e.stack}`); }
      } catch (e) {
        log('ERRO', `scan: ${e.stack}`);
      } finally { scanning = false; }
    }
  }, 500);

  // novos mercados (1x/hora) e tamanho em disco (5 min)
  setInterval(async () => {
    try { const n = app.markets.length; await loadMarkets(); if (app.markets.length > n) { log('INFO', `${app.markets.length - n} mercados novos`); subscribeAll(); } }
    catch (e) { log('AVISO', `lista de mercados: ${e.message}`); }
  }, 3600_000);
  recorder.refreshDisk();
  setInterval(() => recorder.refreshDisk(), 300_000);

  const stop = () => {
    log('INFO', 'encerrando...');
    for (const f of fades) f.save(); momentum?.save(); shadow?.save(); recorder.stop(); ws.stop(); server.close();
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

main().catch((e) => { log('ERRO', e.stack); process.exit(1); });
