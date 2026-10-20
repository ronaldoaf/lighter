import path from 'node:path';
import { log, readJSON, writeJSON, ensureDir } from './util.js';

const H = 3_600_000;
const HORIZONS = [24, 168, 720]; // 1d, 7d, 30d em barras de 1h

/**
 * Forca de tendencia por ativo, em candles de 1h (REST), recalculada 1x/hora (minuto `minuteUTC`).
 *
 *   sigma  = desvio dos log-retornos 1h nas ultimas 720 barras (>= 168 validos)
 *   z_h    = ln(C / C[-h]) / (sigma * sqrt(h))      h = 24, 168, 720   (t-estatistica do drift: retorno em desvios)
 *   score  = 100 * media(clip(z_h, -2, 2)) / 2      -100 (baixa forte) .. +100 (alta forte)
 *            |z| = 2 ja e um movimento de 2 desvios; entre os perps o score tem desvio ~25
 *   r2     = R^2 da regressao de ln(C) no tempo nas ultimas 168 barras (0 = serrilhado, 1 = linha reta)
 *   er     = eficiencia de Kaufman em 7d: |C - C[-168]| / soma |C[i] - C[i-1]|
 *   alinh  = horizontes com o mesmo sinal do score (0..3)
 */
export class TrendBoard {
  constructor({ rest, dataDir, classOf, markets, minuteUTC = 5 }) {
    Object.assign(this, { rest, classOf, markets, minuteUTC });
    this.dir = ensureDir(path.join(dataDir, 'bars_1h'));
    this.keep = 1000; this.warm = 900;
    this.bars = new Map();
    this.rows = []; this.updatedAt = null; this.refreshMs = 0; this.busy = false; this.fails = 0;
  }

  load(sym) {
    if (!this.bars.has(sym)) this.bars.set(sym, readJSON(path.join(this.dir, `${sym}.json`), []));
    return this.bars.get(sym);
  }

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
      this.rows = this.markets().map((mk) => this.measure(mk.symbol, upto)).filter(Boolean);
      this.updatedAt = upto; this.refreshMs = Date.now() - t0; this.fails = fails;
      log('INFO', `tendencia: ${this.rows.length} ativos em ${(this.refreshMs / 1000).toFixed(0)}s (${fails} falhas)`);
    } finally { this.busy = false; }
  }

  /** medidas do ativo com as barras fechadas ate `upto` (exclusive) */
  measure(sym, upto) {
    const b = this.load(sym).filter((x) => x.t < upto);
    if (b.length < 48) return null;
    const last = b.at(-1);
    if (upto - last.t > 6 * H) return null; // sem negocio recente
    const byT = new Map(b.map((x) => [x.t, x]));
    // fechamento em t (ou o ultimo antes dele, ate 3h atras; horas sem negocio nao geram candle)
    const closeAt = (t) => { for (let k = 0; k <= 3; k++) { const x = byT.get(t - k * H); if (x) return x.c; } return NaN; };
    const lr = [];
    for (let t = last.t - 719 * H; t <= last.t; t += H) {
      const x = byT.get(t), p = byT.get(t - H);
      if (x && p && x.c > 0 && p.c > 0) lr.push(Math.log(x.c / p.c));
    }
    if (lr.length < 168) return null;
    const mu = lr.reduce((a, v) => a + v, 0) / lr.length;
    const sigma = Math.sqrt(lr.reduce((a, v) => a + (v - mu) ** 2, 0) / (lr.length - 1));
    if (!(sigma > 0)) return null;

    const ret = {}, z = {};
    for (const h of HORIZONS) {
      const c0 = closeAt(last.t - h * H);
      ret[h] = c0 > 0 ? last.c / c0 - 1 : NaN;
      z[h] = c0 > 0 ? Math.log(last.c / c0) / (sigma * Math.sqrt(h)) : NaN;
    }
    const zs = HORIZONS.map((h) => z[h]).filter(Number.isFinite);
    if (!zs.length) return null;
    const score = 100 * zs.reduce((a, v) => a + Math.max(-2, Math.min(2, v)), 0) / zs.length / 2;
    const align = zs.filter((v) => Math.sign(v) === Math.sign(score)).length;

    // R^2 e eficiencia em 7d
    const w = b.filter((x) => x.t > last.t - 168 * H && x.c > 0);
    let r2 = NaN, er = NaN;
    if (w.length >= 48) {
      const xs = w.map((x) => (x.t - last.t) / H), ys = w.map((x) => Math.log(x.c));
      const mx = xs.reduce((a, v) => a + v, 0) / xs.length, my = ys.reduce((a, v) => a + v, 0) / ys.length;
      let sxy = 0, sxx = 0, syy = 0;
      for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
      r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
      let path = 0;
      for (let i = 1; i < w.length; i++) path += Math.abs(w[i].c - w[i - 1].c);
      er = path > 0 ? Math.abs(w.at(-1).c - w[0].c) / path : 0;
    }
    let vol24 = 0;
    for (const x of b) if (x.t > last.t - 24 * H && x.V > 0) vol24 += x.V;
    // mini grafico: fechamentos de 4 em 4 horas nos ultimos 7 dias
    const spark = [];
    for (let t = last.t - 168 * H; t <= last.t; t += 4 * H) { const c = closeAt(t); if (Number.isFinite(c)) spark.push(+c.toPrecision(6)); }
    return {
      sym, cls: this.classOf(sym), price: last.c, t: last.t, score, align, nz: zs.length,
      z24: z[24], z7: z[168], z30: z[720], r24: ret[24], r7: ret[168], r30: ret[720],
      r2, er, vol: sigma * Math.sqrt(24 * 365), vol24, spark,
    };
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

  view() {
    return { updatedAt: this.updatedAt, refreshMs: this.refreshMs, fails: this.fails, busy: this.busy, rows: this.rows };
  }
}
