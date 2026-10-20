import path from 'node:path';
import { BAR, barStart, log, readJSON, writeJSON, ensureDir } from './util.js';


/**
 * Historico de candles 15m por ativo vindo do REST (mesma fonte do backtest) e calculo das medidas do sinal,
 * replicando search_atr_bar.worker_init / search_atr_vol.worker_init:
 *   ATR14 = media do TR das 14 barras ANTERIORES (todas validas); corpo = |C-O| / ATR14
 *   vr    = V / media de V das 96 barras anteriores (>= 48 validas), V <= 0 -> NaN
 *   liq   = media de V das 672 barras anteriores (>= 96 validas) * 96   (US$/dia)
 */
export class BarStore {
  /** keep = barras guardadas por ativo (o fade usa 672 para a liq); warm = barras baixadas na primeira carga */
  constructor(rest, dataDir, { sub = 'bars', keep = 900, warm = 700 } = {}) {
    this.rest = rest; this.dir = ensureDir(path.join(dataDir, sub));
    this.keep = keep; this.warm = warm;
    this.bars = new Map(); // sym -> [{t,o,h,l,c,V}] ordenado
    this.lastRefresh = null; this.refreshMs = 0;
  }

  load(sym) {
    if (!this.bars.has(sym)) this.bars.set(sym, readJSON(path.join(this.dir, `${sym}.json`), []));
    return this.bars.get(sym);
  }

  save(sym) {
    const b = this.bars.get(sym);
    if (b) writeJSON(path.join(this.dir, `${sym}.json`), b.slice(-this.keep));
  }

  merge(sym, fresh) {
    const b = this.load(sym);
    const m = new Map(b.map((x) => [x.t, x]));
    for (const x of fresh) m.set(x.t, x);
    const out = [...m.values()].sort((a, c) => a.t - c.t).slice(-this.keep);
    this.bars.set(sym, out);
  }

  /** atualiza todos os ativos ate a ultima barra fechada (exclusive `upto`) */
  async refresh(markets, upto) {
    const t0 = Date.now();
    let fails = 0;
    await Promise.all(markets.map(async (mk) => {
      const b = this.load(mk.symbol);
      const from = b.length ? Math.max(b[b.length - 1].t - 2 * BAR, upto - this.keep * BAR) : upto - this.warm * BAR;
      try {
        const fresh = await this.rest.candles(mk.market_id, from, upto);
        this.merge(mk.symbol, fresh);
        this.save(mk.symbol);
      } catch (e) {
        fails++;
        log('AVISO', `candles ${mk.symbol}: ${e.message}`);
      }
    }));
    this.lastRefresh = upto; this.refreshMs = Date.now() - t0;
    return fails;
  }

  /** barra (ou null) do ativo no instante t */
  bar(sym, t) {
    return this.load(sym).find((x) => x.t === t) || null;
  }

  /** medidas do sinal na barra k (inicio da barra em ms) */
  features(sym, k) {
    const b = this.load(sym);
    if (!b.length || b[b.length - 1].t < k) return null;
    const byT = new Map(b.map((x) => [x.t, x]));
    const g = (i) => byT.get(k - i * BAR) || null; // g(0) = barra k, g(1) = k-1 ...
    const cur = g(0);
    if (!cur) return null;

    // ATR14 das barras k-14..k-1
    let trs = 0;
    for (let i = 1; i <= 14; i++) {
      const x = g(i), p = g(i + 1);
      if (!x) return null;
      const tr = p ? Math.max(x.h - x.l, Math.abs(x.h - p.c), Math.abs(x.l - p.c)) : x.h - x.l;
      trs += tr;
    }
    const atr14 = trs / 14;
    const vol = (n, minN) => {
      let s = 0, c = 0;
      for (let i = 1; i <= n; i++) { const x = g(i); if (x && x.V > 0) { s += x.V; c++; } }
      return c >= minN ? s / c : NaN;
    };
    const vMean = vol(96, 48), liq = vol(672, 96) * 96;
    let hi = -Infinity, lo = Infinity; // extremos k-3..k (stop do fade)
    for (let i = 0; i <= 3; i++) { const x = g(i); if (x) { hi = Math.max(hi, x.h); lo = Math.min(lo, x.l); } }
    return {
      t: k, o: cur.o, h: cur.h, l: cur.l, c: cur.c, V: cur.V,
      atr14, body: Math.abs(cur.c - cur.o) / atr14, vr: cur.V > 0 ? cur.V / vMean : NaN, liq,
      dir: Math.sign(cur.c - cur.o), hi4: hi, lo4: lo,
    };
  }
}

/** Barras ao vivo montadas pelos trades do WS (para gatilho, stop e alvo intrabarra). */
export class LiveBars {
  constructor(onClose) {
    this.onClose = onClose; // (sym, bar|null, t, complete) -- null = barra inteira sem negocio
    this.cur = new Map(); this.subAt = new Map(); this.lastClosed = new Map();
    this.lastPx = new Map(); this.lastTs = new Map();
  }

  subscribed(sym) { this.subAt.set(sym, Date.now()); }
  #complete(sym, t) { return (this.subAt.get(sym) ?? Infinity) <= t; }

  /** processa um trade; retorna {t, first} (first = primeiro negocio da barra = abertura) ou null se atrasado */
  trade(sym, px, ts, usd = 0) {
    const t = barStart(ts);
    let b = this.cur.get(sym);
    if (b && t > b.t) { this.#close(sym, b); b = null; }
    if (b && t < b.t) return null;
    if (!b && t <= (this.lastClosed.get(sym) ?? -Infinity)) return null;
    let first = false;
    if (!b) {
      this.#gaps(sym, t);
      b = { t, o: px, h: px, l: px, c: px, V: 0, n: 0, complete: this.#complete(sym, t) };
      this.cur.set(sym, b); first = true;
    }
    b.h = Math.max(b.h, px); b.l = Math.min(b.l, px); b.c = px; b.n++; b.V += usd;
    this.lastPx.set(sym, px); this.lastTs.set(sym, ts);
    return { t, first };
  }

  /** fecha barras vencidas (timer logo apos a virada) */
  tick(now) {
    const t = barStart(now);
    for (const sym of new Set([...this.cur.keys(), ...this.lastClosed.keys()])) {
      const b = this.cur.get(sym);
      if (b && b.t < t) this.#close(sym, b);
      if (!this.cur.has(sym)) this.#gaps(sym, t);
    }
  }

  /** emite null para as barras sem negocio entre a ultima fechada e t (exclusive) */
  #gaps(sym, t) {
    const last = this.lastClosed.get(sym);
    if (last === undefined) return;
    for (let x = last + BAR; x < t; x += BAR) {
      this.lastClosed.set(sym, x);
      this.onClose(sym, null, x, this.#complete(sym, x));
    }
  }

  #close(sym, b) {
    this.cur.delete(sym);
    this.lastClosed.set(sym, b.t);
    this.onClose(sym, b, b.t, b.complete);
  }
}
