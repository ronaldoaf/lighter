/**
 * Indicadores tecnicos calculados em codigo (o JEV nao e confiavel para contas).
 * Entrada: candles fechados [{t,o,h,l,c,V}] em ordem cronologica. Saida: { nome: {value, meaning} }.
 */
const H = 3_600_000;

function ema(xs, n) {
  const k = 2 / (n + 1), out = [];
  let e = xs[0];
  for (const x of xs) { e = x * k + e * (1 - k); out.push(e); }
  return out;
}

/** RSI de Wilder */
function rsi(c, n = 14) {
  if (c.length <= n) return NaN;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

/** ATR e ADX de Wilder */
function atrAdx(b, n = 14) {
  if (b.length <= 2 * n) return { atr: NaN, adx: NaN, pdi: NaN, mdi: NaN };
  const tr = [], pdm = [], mdm = [];
  for (let i = 1; i < b.length; i++) {
    const x = b[i], p = b[i - 1], up = x.h - p.h, dn = p.l - x.l;
    tr.push(Math.max(x.h - x.l, Math.abs(x.h - p.c), Math.abs(x.l - p.c)));
    pdm.push(up > dn && up > 0 ? up : 0); mdm.push(dn > up && dn > 0 ? dn : 0);
  }
  let atr = tr.slice(0, n).reduce((a, v) => a + v, 0), sp = pdm.slice(0, n).reduce((a, v) => a + v, 0), sm = mdm.slice(0, n).reduce((a, v) => a + v, 0);
  const dx = [];
  let pdi = 0, mdi = 0;
  for (let i = n; i < tr.length; i++) {
    atr = atr - atr / n + tr[i]; sp = sp - sp / n + pdm[i]; sm = sm - sm / n + mdm[i];
    pdi = atr ? 100 * sp / atr : 0; mdi = atr ? 100 * sm / atr : 0;
    dx.push(pdi + mdi ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0);
  }
  let adx = dx.slice(0, n).reduce((a, v) => a + v, 0) / n;
  for (let i = n; i < dx.length; i++) adx = (adx * (n - 1) + dx[i]) / n;
  return { atr: atr / n, adx, pdi, mdi };
}

const r = (x, d = 3) => (Number.isFinite(x) ? +x.toFixed(d) : null);
const pctChg = (a, b) => (b > 0 ? (a / b - 1) * 100 : NaN);

/**
 * @param bars candles fechados
 * @param label ex. '15-minute'
 * @param rangeN barras da janela de posicao no range (ex.: 96 = 24h em 15m)
 * @param rangeLabel ex. '24h'
 */
export function indicators(bars, label, rangeN, rangeLabel) {
  const b = bars.filter((x) => x.c > 0);
  if (b.length < 60) return null;
  const c = b.map((x) => x.c), last = b.at(-1), C = last.c;
  const e20 = ema(c, 20), e50 = ema(c, 50), e200 = ema(c, Math.min(200, c.length));
  const m12 = ema(c, 12), m26 = ema(c, 26), macd = m12.map((v, i) => v - m26[i]), sig = ema(macd, 9);
  const w20 = c.slice(-20), mu = w20.reduce((a, v) => a + v, 0) / 20, sd = Math.sqrt(w20.reduce((a, v) => a + (v - mu) ** 2, 0) / 20);
  const { atr, adx, pdi, mdi } = atrAdx(b);
  const rw = b.slice(-rangeN), hi = Math.max(...rw.map((x) => x.h)), lo = Math.min(...rw.map((x) => x.l));
  const v20 = b.slice(-21, -1).map((x) => x.V), vAvg = v20.reduce((a, v) => a + v, 0) / (v20.length || 1);
  const lr = [];
  for (let i = Math.max(1, c.length - 96); i < c.length; i++) lr.push(Math.log(c[i] / c[i - 1]));
  const lmu = lr.reduce((a, v) => a + v, 0) / lr.length, rv = Math.sqrt(lr.reduce((a, v) => a + (v - lmu) ** 2, 0) / (lr.length - 1));
  const at = (k) => c[c.length - 1 - k];
  const I = (value, meaning, d) => ({ value: r(value, d), meaning });
  return {
    last_close: I(C, `close of the last ${label} candle`, 8),
    ret_1: I(pctChg(C, at(1)), `return over the last 1 ${label} candle, %`),
    ret_4: I(pctChg(C, at(4)), `return over the last 4 ${label} candles, %`),
    ret_16: I(pctChg(C, at(16)), `return over the last 16 ${label} candles, %`),
    rsi14: I(rsi(c), 'RSI(14), 0-100', 1),
    macd_hist_pct: I((macd.at(-1) - sig.at(-1)) / C * 100, 'MACD(12,26,9) histogram as % of price', 4),
    macd_hist_change: I(((macd.at(-1) - sig.at(-1)) - (macd.at(-2) - sig.at(-2))) / C * 100, 'change of MACD histogram vs previous candle, % of price', 4),
    bb_pctb: I(sd > 0 ? (C - (mu - 2 * sd)) / (4 * sd) : NaN, 'Bollinger(20,2) %B (0 = lower band, 1 = upper band)'),
    bb_width_pct: I(mu > 0 ? 4 * sd / mu * 100 : NaN, 'Bollinger band width, % of middle band'),
    dist_ema20_pct: I(pctChg(C, e20.at(-1)), 'distance of price from EMA20, %'),
    dist_ema50_pct: I(pctChg(C, e50.at(-1)), 'distance of price from EMA50, %'),
    dist_ema200_pct: I(pctChg(C, e200.at(-1)), `distance of price from EMA${Math.min(200, c.length)}, %`),
    ema50_slope_pct: I(pctChg(e50.at(-1), e50.at(-5)), 'EMA50 change over the last 4 candles, %'),
    adx14: I(adx, 'ADX(14) trend strength (above 25 = trending)', 1),
    plus_di_minus_di: I(pdi - mdi, '+DI minus -DI (positive = buyers dominate)', 1),
    atr14_pct: I(atr / C * 100, 'ATR(14) as % of price'),
    realized_vol_pct: I(rv * 100, `std of ${label} log returns over the last 96 candles, %`),
    range_pos: I(hi > lo ? (C - lo) / (hi - lo) : NaN, `close position within the ${rangeLabel} high-low range (0 = low, 1 = high)`),
    dist_range_high_pct: I(pctChg(C, hi), `distance from the ${rangeLabel} high, %`),
    dist_range_low_pct: I(pctChg(C, lo), `distance from the ${rangeLabel} low, %`),
    volume_ratio: I(vAvg > 0 ? last.V / vAvg : NaN, 'last candle volume / average of the previous 20 candles'),
    body_atr: I(atr > 0 ? (last.c - last.o) / atr : NaN, 'last candle body (close - open) in ATR units'),
    upper_wick_atr: I(atr > 0 ? (last.h - Math.max(last.o, last.c)) / atr : NaN, 'last candle upper wick in ATR units'),
    lower_wick_atr: I(atr > 0 ? (Math.min(last.o, last.c) - last.l) / atr : NaN, 'last candle lower wick in ATR units'),
  };
}

/** agrega candles de 1h em 4h (blocos UTC 00/04/08/...), so blocos completos que fecham ate T */
export function to4h(bars1h, T) {
  const B = 4 * H, groups = new Map();
  for (const x of bars1h) {
    if (x.t + H > T) continue;
    const k = Math.floor(x.t / B) * B;
    (groups.get(k) ?? groups.set(k, []).get(k)).push(x);
  }
  const out = [];
  for (const [k, g] of [...groups].sort((a, b) => a[0] - b[0])) {
    if (g.length !== 4 || k + B > T) continue;
    g.sort((a, b) => a.t - b.t);
    out.push({ t: k, o: g[0].o, h: Math.max(...g.map((x) => x.h)), l: Math.min(...g.map((x) => x.l)), c: g[3].c, V: g.reduce((a, x) => a + (x.V || 0), 0) });
  }
  return out;
}
