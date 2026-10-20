/**
 * Kelly para resultados em R (multiplos do risco): f* = argmax_f  E[ log(1 + f * R) ],
 * f = fracao do capital arriscada por trade. Amostra = R liquidos do backtest (prior, com peso w)
 * + R reais dos trades do paper (peso 1), entao o tamanho se ajusta conforme o paper acumula historico.
 */
export function kellyFraction(prior, priorWeight, live) {
  const rs = [], ws = [];
  for (const r of prior) { rs.push(r); ws.push(priorWeight); }
  for (const r of live) { rs.push(r); ws.push(1); }
  if (!rs.length) return 0;
  const minR = Math.min(...rs);
  const fmax = minR < 0 ? Math.min(1, 0.999 / -minR) : 1;
  let best = 0, bestG = 0; // f = 0 -> crescimento 0 (nao operar se nada for positivo)
  for (let i = 1; i <= 1000; i++) {
    const f = (fmax * i) / 1000;
    let g = 0, W = 0;
    for (let k = 0; k < rs.length; k++) { g += ws[k] * Math.log1p(f * rs[k]); W += ws[k]; }
    g /= W;
    if (g > bestG) { bestG = g; best = f; }
  }
  return best;
}

export function summary(rs) {
  if (!rs.length) return { n: 0 };
  const n = rs.length, mean = rs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  return { n, mean, sd, win: rs.filter((r) => r > 0).length / n };
}
