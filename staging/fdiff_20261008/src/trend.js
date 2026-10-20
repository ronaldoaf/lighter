import path from 'node:path';
import { BAR, log, readJSON, writeJSON, ensureDir } from './util.js';

const H = 3_600_000;
// conjuntos de horizontes (horas): R^2/eficiencia na janela `fit`, mini grafico de `spark` horas a cada `step`
const SETS = {
  longo: { h: [24, 168, 720], fit: 168, spark: 168, step: 4 }, // 1d, 7d, 30d
  curto: { h: [4, 24, 168], fit: 24, spark: 48, step: 1 },     // 4h, 1d, 7d
};
export const MAX_LAG = 288; // atraso maximo em barras de 15m (72h)

/**
 * Forca de tendencia por ativo no instante T (grade de 15m), com atraso opcional: T = ultima barra 15m fechada - lag * 15m.
 *
 * Precos: fechamento no instante E vem dos candles 15m do fade (BarStore, ~9 dias, atualizados a cada barra);
 * mais antigo que isso, do candle 1h que fecha na hora cheia <= E (candles 1h proprios, REST, 1x/hora no minuto `minuteUTC`).
 *
 *   sigma  = desvio dos log-retornos 1h nas ultimas 720 barras de 1h fechadas ate T (>= 168 validos)
 *   z_h    = ln(C_T / C_{T-h}) / (sigma * sqrt(h))  t-estatistica do drift: retorno em desvios
 *            dois conjuntos: longo h = 1d, 7d, 30d (R^2/efic. em 7d) e curto h = 4h, 1d, 7d (R^2/efic. em 1d)
 *   score  = 100 * media(clip(z_h, -2, 2)) / 2      -100 (baixa forte) .. +100 (alta forte)
 *            |z| = 2 ja e um movimento de 2 desvios; entre os perps o score tem desvio ~25
 *   r2     = R^2 da regressao de ln(C) (amostrado de hora em hora ate T) no tempo, na janela do conjunto
 *   er     = eficiencia de Kaufman na janela: |C_T - C_{T-n}| / soma |C[i] - C[i-1]|
 *   alinh  = horizontes com o mesmo sinal do score (0..3)
 */
export class TrendBoard {
  constructor({ rest, dataDir, classOf, markets, bars15, minuteUTC = 5 }) {
    Object.assign(this, { rest, classOf, markets, bars15, minuteUTC });
    this.dir = ensureDir(path.join(dataDir, 'bars_1h'));
    this.keep = 1000; this.warm = 900;
    this.bars = new Map();
    this.updatedAt = null; this.refreshMs = 0; this.busy = false; this.fails = 0;
    this.ver = null; this.idx = new Map(); this.cache = new Map();
  }

  load(sym) {
    if (!this.bars.has(sym)) this.bars.set(sym, readJSON(path.join(this.dir, `${sym}.json`), []));
    return this.bars.get(sym);
  }

  /** candles 1h ate a ultima hora fechada */
  async refresh() {
    if (this.busy) return;
    this.busy = true;
    const t0 = Date.now(), upto = Math.floor(t0 / H) * H;
    let fails = 0;
    try {
      await Promise.all(this.markets().map(async (mk) => {
        const sym = mk.symbol, b = this.load(sym);
        if (b.length && b.at(-1).t >= upto - H) return; // ja tem a ultima hora fechada
        const from = b.length ? Math.max(b.at(-1).t - 2 * H, upto - this.keep * H) : upto - this.warm * H;
        try {
          const fresh = await this.rest.candles(mk.market_id, from, upto, '1h');
          const m = new Map(b.map((x) => [x.t, x]));
          for (const x of fresh) m.set(x.t, x);
          const out = [...m.values()].sort((a, c) => a.t - c.t).slice(-this.keep);
          this.bars.set(sym, out);
          writeJSON(path.join(this.dir, `${sym}.json`), out);
        } catch (e) {
          fails++;
          log('AVISO', `candles 1h ${sym}: ${e.message}`);
        }
      }));
      this.updatedAt = upto; this.refreshMs = Date.now() - t0; this.fails = fails;
      log('INFO', `tendencia: candles 1h de ${this.markets().length} ativos em ${(this.refreshMs / 1000).toFixed(0)}s (${fails} falhas)`);
    } finally { this.busy = false; }
  }

  /** indices por ativo (refeitos quando chegam candles novos de 15m ou 1h) */
  index() {
    const ver = `${this.bars15?.lastRefresh}|${this.updatedAt}`;
    if (ver === this.ver) return this.idx;
    this.ver = ver; this.cache.clear(); this.idx = new Map();
    for (const mk of this.markets()) {
      const b1 = this.load(mk.symbol), b15 = this.bars15?.load(mk.symbol) ?? [];
      this.idx.set(mk.symbol, { b1, m1: new Map(b1.map((x) => [x.t, x])), m15: new Map(b15.map((x) => [x.t, x])), first15: b15[0]?.t ?? Infinity });
    }
    return this.idx;
  }

  /** fechamento no instante E: {c, end} (end = fim do candle usado) ou null; horas/barras sem negocio nao geram candle */
  static px(ix, E) {
    if (E - BAR >= ix.first15) {
      for (let k = 0; k < 8; k++) { const x = ix.m15.get(E - (k + 1) * BAR); if (x && x.c > 0) return { c: x.c, end: x.t + BAR }; }
    }
    const e1 = Math.floor(E / H) * H;
    for (let k = 0; k < 4; k++) { const x = ix.m1.get(e1 - (k + 1) * H); if (x && x.c > 0) return { c: x.c, end: x.t + H }; }
    return null;
  }

  /** medidas do ativo no instante T */
  measure(sym, ix, T) {
    const now = TrendBoard.px(ix, T);
    if (!now || T - now.end > 6 * H) return null; // sem negocio recente
    // sigma: retornos de 1h consecutivos nas 720 barras de 1h que fecham ate T
    let hi = ix.b1.length - 1;
    while (hi >= 0 && ix.b1[hi].t + H > T) hi--;
    const lr = [];
    for (let i = Math.max(1, hi - 719); i <= hi; i++) {
      const x = ix.b1[i], p = ix.b1[i - 1];
      if (x.t - p.t === H && x.c > 0 && p.c > 0) lr.push(Math.log(x.c / p.c));
    }
    if (lr.length < 168) return null;
    const mu = lr.reduce((a, v) => a + v, 0) / lr.length;
    const sigma = Math.sqrt(lr.reduce((a, v) => a + (v - mu) ** 2, 0) / (lr.length - 1));
    if (!(sigma > 0)) return null;

    let vol24 = 0;
    if (T - 24 * H >= ix.first15) { for (let t = T - 24 * H; t < T; t += BAR) vol24 += Math.max(0, ix.m15.get(t)?.V ?? 0); }
    else { for (let t = Math.floor(T / H) * H - 24 * H; t < Math.floor(T / H) * H; t += H) vol24 += Math.max(0, ix.m1.get(t)?.V ?? 0); }

    const hourly = new Map(); // k -> fechamento em T - k horas
    const at = (k) => { if (!hourly.has(k)) hourly.set(k, TrendBoard.px(ix, T - k * H)?.c ?? NaN); return hourly.get(k); };
    const sets = {};
    for (const [name, S] of Object.entries(SETS)) {
      const r = [], z = [];
      for (const h of S.h) {
        const c0 = at(h);
        r.push(c0 > 0 ? now.c / c0 - 1 : NaN);
        z.push(c0 > 0 ? Math.log(now.c / c0) / (sigma * Math.sqrt(h)) : NaN);
      }
      const zs = z.filter(Number.isFinite);
      if (!zs.length) return null;
      const score = 100 * zs.reduce((a, v) => a + Math.max(-2, Math.min(2, v)), 0) / zs.length / 2;
      const align = zs.filter((v) => Math.sign(v) === Math.sign(score)).length;
      const w = [];
      for (let k = S.fit; k >= 0; k--) { const c = at(k); if (c > 0) w.push({ k, c }); }
      const spark = []; // fechamentos para o mini grafico
      for (let k = S.spark; k >= 0; k -= S.step) { const c = at(k); if (c > 0) spark.push(+c.toPrecision(6)); }
      sets[name] = { score, align, nz: zs.length, z, r, ...TrendBoard.fit(w, S.fit / 4), spark };
    }
    return { sym, cls: this.classOf(sym), price: now.c, vol: sigma * Math.sqrt(24 * 365), vol24, sets };
  }

  /** R^2 de ln(C) no tempo e eficiencia de Kaufman nos pontos w = [{k (horas antes de T), c}] em ordem cronologica */
  static fit(w, minN) {
    if (w.length < minN || w.length < 3) return { r2: NaN, er: NaN };
    const xs = w.map((x) => -x.k), ys = w.map((x) => Math.log(x.c));
    const mx = xs.reduce((a, v) => a + v, 0) / xs.length, my = ys.reduce((a, v) => a + v, 0) / ys.length;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
    let path = 0;
    for (let i = 1; i < w.length; i++) path += Math.abs(w[i].c - w[i - 1].c);
    return { r2: syy > 0 ? (sxy * sxy) / (sxx * syy) : 0, er: path > 0 ? Math.abs(w.at(-1).c - w[0].c) / path : 0 };
  }

  /** proxima execucao: minuto `minuteUTC` de cada hora */
  start() {
    const tick = () => {
      const now = Date.now(), next = Math.floor(now / H) * H + H + this.minuteUTC * 60_000;
      setTimeout(() => this.refresh().catch((e) => log('ERRO', `tendencia: ${e.stack}`)).finally(tick), next - now);
    };
    tick();
    return this.refresh();
  }

  /** estado com `lag` barras de 15m de atraso em relacao a ultima barra 15m fechada */
  view(lag = 0) {
    lag = Math.max(0, Math.min(MAX_LAG, Math.round(+lag) || 0));
    const base = { sets: Object.fromEntries(Object.entries(SETS).map(([k, v]) => [k, v.h])), lag, maxLag: MAX_LAG,
      updatedAt: this.updatedAt, refreshMs: this.refreshMs, fails: this.fails, busy: this.busy };
    const T0 = this.bars15?.lastRefresh ?? this.updatedAt;
    if (!T0 || this.updatedAt === null) return { ...base, T: null, T0, rows: [] };
    const T = T0 - lag * BAR, ix = this.index();
    if (!this.cache.has(T)) {
      if (this.cache.size > 50) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(T, [...ix.keys()].map((sym) => this.measure(sym, ix.get(sym), T)).filter(Boolean));
    }
    return { ...base, T, T0, rows: this.cache.get(T) };
  }
}
