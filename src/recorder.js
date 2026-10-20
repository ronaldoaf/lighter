import path from 'node:path';
import { DailyFile, dirSize, ensureDir, log } from './util.js';
import { OrderBook } from './book.js';

/**
 * Gravacao continua do livro de ofertas de todos os perps:
 *   book/<dia>/metrics.csv  a cada intervalSec (e a cada hotIntervalSec nos ativos "quentes": sinal, setup, posicao)
 *                           bid, ask, spread, custo por perna p/ US$1k/5k/20k (meio spread + slippage), profundidade
 *   book/<dia>/depth.jsonl  top N niveis de cada lado a cada depthEveryMin (quentes: depthHotEverySec) + eventos
 *   book/<dia>/trades.csv   todos os negocios
 *   book/<dia>/stats.csv    market_stats (mark, index, premium, OI, funding) a cada statsEverySec (quentes: statsHotEverySec)
 * Dias anteriores sao comprimidos em .gz na virada.
 */
export class Recorder {
  constructor(cfg, dataDir, classOf) {
    this.cfg = cfg; this.classOf = classOf;
    this.dir = ensureDir(path.join(dataDir, 'book'));
    this.books = new Map();
    this.hot = new Map(); // sym -> expira em (ms)
    this.sizes = cfg.costSizesUSD;
    this.metrics = new DailyFile(this.dir, 'metrics.csv',
      ['ts', 'sym', 'cls', 'bid', 'ask', 'mid', 'spread_bps', ...this.sizes.map((u) => `cost_${u}`),
        'depth_bid_0.5pct', 'depth_ask_0.5pct', 'depth_bid_1pct', 'depth_ask_1pct', 'hot'].join(','));
    this.depth = new DailyFile(this.dir, 'depth.jsonl', null);
    this.trades = new DailyFile(this.dir, 'trades.csv', 'ts,sym,price,usd,taker_side,type');
    this.statsFile = new DailyFile(this.dir, 'stats.csv',
      'ts,sym,mark,index,mid,last,premium,oi,funding_cur,funding_rate,vol_quote_24h,hot');
    this.stats = new Map(); // sym -> ultimo market_stats (as mensagens trazem so os mercados que mudaram)
    this.calm = new Map(); // sym -> ultimos 1440 custos de US$1k (1/min) para "custo tipico"
    this.lastCost = new Map();
    this.rows = 0; this.lastWrite = 0; this.started = Date.now();
  }

  book(sym) {
    if (!this.books.has(sym)) this.books.set(sym, new OrderBook(sym));
    return this.books.get(sym);
  }

  markHot(sym, ms = this.cfg.hotHoldMin * 60_000) {
    this.hot.set(sym, Math.max(this.hot.get(sym) || 0, Date.now() + ms));
  }
  isHot(sym, now = Date.now()) { return (this.hot.get(sym) || 0) > now; }

  start() {
    let tick = 0;
    this.timer = setInterval(() => {
      tick++;
      const now = Date.now();
      const all = tick % this.cfg.intervalSec === 0;
      const depthAll = tick % (this.cfg.depthEveryMin * 60) === 0;
      const depthHot = tick % this.cfg.depthHotEverySec === 0;
      for (const [sym, b] of this.books) {
        if (!b.ready) continue;
        const hot = this.isHot(sym, now);
        if (all || (hot && tick % this.cfg.hotIntervalSec === 0)) this.#metric(now, sym, b, hot);
        if (depthAll || (hot && depthHot)) this.snapshot(sym, hot ? 'hot' : 'periodic', now);
      }
      const statsAll = tick % (this.cfg.statsEverySec ?? 60) === 0;
      const statsHot = tick % (this.cfg.statsHotEverySec ?? 5) === 0;
      if (statsAll || statsHot) {
        for (const [sym, ms] of this.stats) {
          const hot = this.isHot(sym, now);
          if (statsAll || hot) this.#stat(now, sym, ms, hot);
        }
      }
      if (tick % 60 === 0) {
        for (const [sym, c] of this.lastCost) {
          const a = this.calm.get(sym) || [];
          a.push(c); if (a.length > 1440) a.shift();
          this.calm.set(sym, a);
        }
        for (const [s, t] of this.hot) if (t < now) this.hot.delete(s);
      }
      if (tick % 5 === 0) { this.metrics.flush(); this.depth.flush(); this.trades.flush(); this.statsFile.flush(); }
    }, 1000);
  }

  stop() {
    clearInterval(this.timer);
    this.metrics.flush(); this.depth.flush(); this.trades.flush(); this.statsFile.flush();
  }

  onStats(sym, ms) { if (sym) this.stats.set(sym, ms); }

  #stat(now, sym, m, hot) {
    this.statsFile.write(now, [now, sym, m.mark_price, m.index_price, m.mid_price, m.last_trade_price, m.premium,
      m.open_interest, m.current_funding_rate, m.funding_rate, Math.round(m.daily_quote_token_volume ?? 0), hot ? 1 : 0].join(','));
  }

  #metric(now, sym, b, hot) {
    const t = b.top();
    if (!t) return;
    const costs = this.sizes.map((u) => b.cost(u));
    const d05 = b.depth(0.005), d1 = b.depth(0.01);
    this.lastCost.set(sym, costs[0]);
    const f = (x) => (Number.isFinite(x) ? +x.toPrecision(6) : '');
    this.metrics.write(now, [now, sym, this.classOf(sym), t.bid, t.ask, f(t.mid), f((t.ask - t.bid) / t.mid * 1e4),
      ...costs.map(f), Math.round(d05.bid), Math.round(d05.ask), Math.round(d1.bid), Math.round(d1.ask), hot ? 1 : 0].join(','));
    this.rows++; this.lastWrite = now;
  }

  /** foto dos N niveis do livro (tag: periodic/hot/signal/fill/exit) */
  snapshot(sym, tag, now = Date.now(), extra) {
    const b = this.books.get(sym);
    if (!b?.ready) return;
    const { a, b: bids } = b.levels(this.cfg.depthLevels);
    this.depth.write(now, JSON.stringify({ ts: now, sym, tag, a, b: bids, ...(extra || {}) }));
  }

  trade(sym, x) {
    const ts = x.timestamp;
    this.trades.write(ts, `${ts},${sym},${x.price},${x.usd_amount},${x.is_maker_ask ? 'buy' : 'sell'},${x.type}`);
  }

  /** custo tipico (mediana das ultimas 24h, 1 amostra/min) para US$1k */
  calmCost(sym) {
    const a = this.calm.get(sym);
    if (!a?.length) return NaN;
    const s = [...a].filter(Number.isFinite).sort((x, y) => x - y);
    return s.length ? s[Math.floor(s.length / 2)] : NaN;
  }

  status() {
    let ready = 0, gaps = 0, stale = 0;
    const now = Date.now();
    for (const b of this.books.values()) {
      if (b.ready) ready++;
      gaps += b.gaps;
      if (b.ready && now - b.updatedAt > 10 * 60_000) stale++;
    }
    return { livros: this.books.size, prontos: ready, semAtualizar10min: stale, quebrasNonce: gaps,
      linhas: this.rows, ultimaGravacao: this.lastWrite, quentes: [...this.hot.keys()],
      discoMB: this.diskMB ?? null };
  }

  refreshDisk() {
    try { this.diskMB = dirSize(this.dir) / 1e6; } catch (e) { log('AVISO', `disco: ${e.message}`); }
  }
}
