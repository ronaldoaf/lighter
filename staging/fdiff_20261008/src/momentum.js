import path from 'node:path';
import { BAR, log, readJSON, writeJSON, ensureDir, CsvLog } from './util.js';

const DAY = 86_400_000, HOUR = 3_600_000;

/**
 * Momentum cross-sectional 14d ajustado por vol (ACHADOS secao 9.1), em paper trading.
 *
 * Rebalanceamento 1x/dia no fechamento da barra das `rebalanceHourUTC` h (barra k = T - 15m), candles REST:
 *   elegiveis: classe cripto, liq >= liqMinUSD, existem C[k], C[k - 14d] e vol30
 *     liq   = soma de V (V <= 0 ou barra ausente = 0) nas 672 barras ate k inclusive / 672 * 96
 *     vol30 = desvio (ddof 1) dos log-retornos 15m nas 2880 barras ate k (>= 672 validos) * sqrt(96)
 *     chave = (C[k] / C[k - 14d] - 1) / vol30
 *   meta do dia: compra os N maiores, vende os N menores (exige 2N elegiveis), +-0.5/N cada (meta zero se nao houver)
 *   carteira = media das H ultimas metas (holding H dias sobreposto, giro ~1/H)   == search_xsec_mom.targets/pnl
 *   alvo em US$ = peso * alavancagem bruta * capital; bruta = min(teto, kellyFraction * f*),
 *   f* = argmax E[log(1 + f r)] sobre os retornos diarios liquidos do backtest (prior) + os do paper
 *
 * Dois resultados:
 *   teorico: como o backtest -> retorno de fechamento a fechamento das barras k, custo medido no livro na hora do
 *            rebalanceamento sobre o giro, funding horario sobre a carteira teorica
 *   real   : ordens a mercado varrendo o livro gravado no instante do rebalanceamento + funding horario.
 *            O capital do paper evolui pelo real.
 */
export class Momentum {
  constructor({ cfg, dataDir, recorder, bars, live, classOf, markets }) {
    Object.assign(this, { cfg, recorder, bars, live, classOf, markets });
    this.dir = ensureDir(path.join(dataDir, 'momentum'));
    this.file = path.join(this.dir, 'state.json');
    this.st = readJSON(this.file, null) ?? {
      startedAt: Date.now(), startEquity: cfg.initialEquity, cash: cfg.initialEquity,
      pos: {},        // sym -> {q (com sinal), avg, funding, lastFundingTs}
      targets: [],    // [{T, w: {sym: peso}}] ultimas H metas
      theo: null,     // {eq, gross, hold: {sym: peso}, lastC: {sym: preco}, T}
      lastT: null, lastEqAfter: null, lastGross: null,
      daily: [],      // [{T, real, theo}] retornos diarios por unidade de bruto (real alimenta o Kelly)
      rebalances: [], fills: [], curve: [], ranking: null,
      pending: [], eqRef: null, // ordens adiadas (sem livro) e capital de referencia dos alvos
    };
    this.prior = readJSON(path.resolve(cfg.priorFile), null);
    this.stats = new Map();
    this.busy = false; this.ready = false; this.warm = false;
    this.rebCsv = new CsvLog(path.join(this.dir, 'rebalances.csv'), ['T', 'executed_at', 'late_min', 'eligible', 'long', 'short',
      'gross', 'equity_before', 'equity_after', 'turnover_usd', 'cost_real_usd', 'cost_theo_usd', 'ret_real', 'ret_theo', 'theo_equity']);
    this.fillCsv = new CsvLog(path.join(this.dir, 'fills.csv'), ['ts', 'sym', 'side', 'usd', 'qty', 'px', 'mid', 'slip', 'cost_book', 'complete']);
  }

  save() { writeJSON(this.file, this.st); }
  cryptoMarkets() { return this.markets().filter((m) => this.classOf(m.symbol) === 'cripto'); }

  // ---------------------------------------------------------------- medidas e metas
  /** medidas do ativo na barra k (inicio da barra) */
  features(sym, k) {
    const b = this.bars.load(sym);
    if (!b.length) return null;
    const byT = new Map(b.map((x) => [x.t, x]));
    const g = (i) => byT.get(k - i * BAR);
    const cur = g(0), old = g(this.cfg.lookbackDays * 96);
    let sv = 0;
    for (let i = 0; i < 672; i++) { const x = g(i); if (x && x.V > 0) sv += x.V; }
    const liq = sv / 672 * 96;
    const lr = [];
    for (let i = 0; i < this.cfg.volDays * 96; i++) {
      const x = g(i), p = g(i + 1);
      if (x && p) lr.push(Math.log(x.c / p.c));
    }
    let vol = NaN;
    if (lr.length >= 672) {
      const m = lr.reduce((a, v) => a + v, 0) / lr.length;
      vol = Math.sqrt(lr.reduce((a, v) => a + (v - m) ** 2, 0) / (lr.length - 1)) * Math.sqrt(96);
    }
    const r = cur && old ? cur.c / old.c - 1 : NaN;
    return { c: cur?.c ?? NaN, r, vol, liq, key: r / vol };
  }

  /** meta do dia para a barra k: {elig, long, short, w} */
  target(k, syms) {
    const C = this.cfg, elig = {};
    for (const sym of syms) {
      const f = this.features(sym, k);
      if (f && f.liq >= C.liqMinUSD && Number.isFinite(f.r) && Number.isFinite(f.c) && Number.isFinite(f.vol) && f.vol > 0) elig[sym] = f;
    }
    const names = Object.keys(elig).sort(); // ordem alfabetica = ordem do painel do backtest
    const w = {};
    let long = [], short = [];
    if (names.length >= 2 * C.perSide) {
      const o = names.map((s, i) => [s, i]).sort((a, b) => elig[a[0]].key - elig[b[0]].key || a[1] - b[1]).map((x) => x[0]);
      short = o.slice(0, C.perSide); long = o.slice(-C.perSide);
      for (const s of long) w[s] = 0.5 / C.perSide;
      for (const s of short) w[s] = -0.5 / C.perSide;
    }
    return { elig, long, short, w };
  }

  hold() {
    const h = {}, ts = this.st.targets;
    for (const t of ts) for (const [s, w] of Object.entries(t.w)) h[s] = (h[s] ?? 0) + w / ts.length;
    return h;
  }

  // ---------------------------------------------------------------- tamanho (1/2 Kelly)
  kelly() {
    const rs = [...(this.prior?.r ?? []), ...this.st.daily.map((d) => d.real).filter(Number.isFinite)];
    if (!rs.length) return 0;
    const minR = Math.min(...rs), cap = 20;
    const fmax = minR < 0 ? Math.min(cap, 0.999 / -minR) : cap;
    let best = 0, bestG = 0;
    for (let i = 1; i <= 2000; i++) {
      const f = (fmax * i) / 2000;
      let g = 0;
      for (const r of rs) g += Math.log1p(f * r);
      if (g > bestG) { bestG = g; best = f; }
    }
    return best;
  }

  grossTarget() {
    this.kellyFull = this.kelly();
    return Math.min(this.cfg.maxGrossLeverage, this.cfg.kellyFraction * this.kellyFull);
  }

  // ---------------------------------------------------------------- precos
  mid(sym) {
    const t = this.recorder.books.get(sym)?.top();
    return t?.mid ?? this.live.lastPx.get(sym) ?? NaN;
  }

  equityMark() {
    let eq = this.st.cash;
    for (const [s, p] of Object.entries(this.st.pos)) {
      const m = this.mid(s);
      eq += p.q * (Number.isFinite(m) ? m : p.avg);
    }
    return eq;
  }

  theoMark() {
    const th = this.st.theo;
    if (!th) return null;
    let r = 0;
    for (const [s, w] of Object.entries(th.hold)) {
      const m = this.mid(s), c0 = th.lastC[s];
      if (Number.isFinite(m) && c0) r += w * th.gross * (m / c0 - 1);
    }
    return th.eq * (1 + r);
  }

  // ---------------------------------------------------------------- rebalanceamento
  /** instante T do ultimo rebalanceamento programado <= now */
  scheduledT(now) {
    const off = this.cfg.rebalanceHourUTC * HOUR;
    const T = Math.floor((now - off) / DAY) * DAY + off;
    return T;
  }

  /** aquece o historico longo (so cripto) e recupera: faz o rebalanceamento perdido, se houver */
  async start(now = Date.now()) {
    const T = this.scheduledT(now);
    log('INFO', `momentum: aquecendo historico de ${this.cfg.volDays + 7}d (${this.cryptoMarkets().length} perps cripto)...`);
    const fails = await this.bars.refresh(this.cryptoMarkets(), T);
    log('INFO', `momentum: historico pronto em ${(this.bars.refreshMs / 1000).toFixed(0)}s (${fails} falhas)`);
    this.warm = true;
    if (this.st.lastT === null || this.st.lastT < T) {
      await this.#waitBooks();
      await this.rebalance(T, { label: this.st.lastT === null ? 'rebalanceamento INICIAL' : 'rebalanceamento ATRASADO (app parado na hora)' });
    } else if (this.st.pending?.length) {
      await this.#waitBooks();
      this.retry();
    }
    this.ready = true;
  }

  /** depois de um reinicio, espera os livros dos perps cripto receberem o snapshot (ate 5 min) */
  async #waitBooks(maxMs = 300_000) {
    const t0 = Date.now(), syms = this.cryptoMarkets().map((m) => m.symbol);
    for (;;) {
      const ready = syms.filter((s) => this.recorder.books.get(s)?.ready).length;
      if (ready >= syms.length * 0.97 || Date.now() - t0 > maxMs) {
        log('INFO', `momentum: ${ready}/${syms.length} livros prontos`);
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  /** chamado a cada fechamento de barra; rebalanceia quando a barra fechada e a da hora programada */
  async onBarClose(T) {
    if (!this.ready || T !== this.scheduledT(T) || this.st.lastT === T) return;
    await this.bars.refresh(this.cryptoMarkets(), T);
    await this.rebalance(T);
  }

  async rebalance(T, { label = 'rebalanceamento' } = {}) {
    if (this.busy) return;
    this.busy = true;
    try { this.#rebalance(T, label); } catch (e) { log('ERRO', `momentum rebalance: ${e.stack}`); } finally { this.busy = false; }
  }

  #rebalance(T, label) {
    const C = this.cfg, k = T - BAR, syms = this.cryptoMarkets().map((m) => m.symbol);
    const now = Date.now();

    // 1) metas: na primeira vez, reconstroi as H-1 anteriores pelo historico (carteira ja em regime)
    if (!this.st.targets.length) {
      for (let d = C.holdDays - 1; d >= 1; d--) this.st.targets.push({ T: T - d * DAY, w: this.target(k - d * DAY, syms).w });
    }
    const tg = this.target(k, syms);
    this.st.targets = this.st.targets.filter((x) => x.T < T).concat([{ T, w: tg.w }]).slice(-C.holdDays);
    const hold = this.hold();
    const gross = this.grossTarget();

    // 2) teorico: retorno de fechamento a fechamento desde o ultimo rebalanceamento, custo do giro medido no livro
    const close = (s) => this.bars.bar(s, k)?.c;
    let th = this.st.theo, retTheo = null;
    const initial = !th; // na 1a vez o teorico parte do preco de agora (nao do fechamento de horas atras)
    if (th) {
      let r = 0;
      for (const [s, w] of Object.entries(th.hold)) {
        const c1 = close(s), c0 = th.lastC[s];
        if (c1 && c0) r += w * th.gross * (c1 / c0 - 1);
      }
      retTheo = r + th.fundingPending / th.eq;
      th.eq *= 1 + r; th.eq += th.fundingPending;
    } else th = { eq: this.equityMark(), gross: 0, hold: {}, lastC: {}, fundingPending: 0 };
    let costTheo = 0;
    for (const s of new Set([...Object.keys(hold), ...Object.keys(th.hold)])) {
      const dTheo = Math.abs((hold[s] ?? 0) * gross - (th.hold[s] ?? 0) * th.gross) * th.eq;
      if (dTheo <= 0) continue;
      const book = this.recorder.books.get(s);
      const c = book?.ready ? book.cost(Math.max(dTheo, 1)) : NaN; // sem livro / livro raso: 0.15%
      costTheo += dTheo * (Number.isFinite(c) ? c : 0.0015);
    }
    th.eq -= costTheo;
    th.hold = hold; th.gross = gross; th.T = T; th.fundingPending = 0;
    th.lastC = Object.fromEntries(Object.keys(hold).map((s) => [s, initial ? this.mid(s) : close(s)]).filter((x) => Number.isFinite(x[1]) && x[1] > 0));
    this.st.theo = th;

    // 3) real: marca o capital e leva cada ativo ao alvo varrendo o livro
    const eqBefore = this.equityMark();
    const retReal = this.st.lastEqAfter ? (eqBefore - this.st.lastEqAfter) / this.st.lastEqAfter : null;
    this.st.eqRef = eqBefore; // capital de referencia dos alvos ate o proximo rebalanceamento
    const ex = this.#execute([...new Set([...Object.keys(hold), ...Object.keys(this.st.pos)])], now);
    const eqAfter = this.equityMark();

    // 4) registros
    if (retReal !== null) this.st.daily.push({ T, real: this.st.lastGross ? retReal / this.st.lastGross : null, theo: retTheo !== null && this.st.lastGross ? retTheo / this.st.lastGross : null, retReal, retTheo });
    this.st.lastT = T; this.st.lastEqAfter = eqAfter; this.st.lastGross = gross;
    const top = (arr) => arr.map((s) => ({ sym: s, ...tg.elig[s] }));
    this.st.ranking = { T, eligible: Object.keys(tg.elig).length, long: top(tg.long).reverse(), short: top(tg.short),
      all: Object.entries(tg.elig).map(([sym, f]) => ({ sym, ...f })).sort((a, b) => b.key - a.key) };
    const row = { T, executed_at: now, late_min: (now - T) / 60_000, eligible: Object.keys(tg.elig).length, long: tg.long.join(' '),
      short: tg.short.join(' '), gross, equity_before: eqBefore, equity_after: eqAfter, turnover_usd: ex.turnover, cost_real_usd: ex.cost,
      cost_theo_usd: costTheo, ret_real: retReal, ret_theo: retTheo, theo_equity: th.eq };
    this.rebCsv.append({ ...row, T: new Date(T).toISOString(), executed_at: new Date(now).toISOString() });
    this.st.rebalances.unshift(row); this.st.rebalances.length = Math.min(this.st.rebalances.length, 120);
    log('MOMENTUM', `${label} ${new Date(T).toISOString().slice(0, 16)}: ` +
      `compra ${tg.long.join(',') || '-'} | vende ${tg.short.join(',') || '-'} | ${Object.keys(tg.elig).length} elegiveis | ` +
      `bruto ${gross.toFixed(2)}x | giro $${ex.turnover.toFixed(0)} | custo $${ex.cost.toFixed(2)} (teo $${costTheo.toFixed(2)})` +
      (ex.pending.length ? ` | adiados: ${ex.pending.join(',')}` : ''));
    this.markCurve();
    this.save();
    this.#scheduleRetry();
  }

  /** leva os ativos `syms` ao alvo (peso da carteira x bruto x capital de referencia), varrendo o livro.
   *  Ativos sem livro ficam em st.pending e sao tentados de novo a cada minuto. */
  #execute(syms, now = Date.now()) {
    const C = this.cfg, th = this.st.theo;
    let turnover = 0, cost = 0;
    const pending = [];
    for (const s of syms) {
      const w = (th.hold[s] ?? 0) * th.gross;
      const book = this.recorder.books.get(s);
      const mid = this.mid(s);
      const p = this.st.pos[s] ?? { q: 0, avg: 0, funding: 0, lastFundingTs: this.stats.get(s)?.funding_timestamp ?? now };
      if (!book?.ready || !Number.isFinite(mid)) { pending.push(s); continue; }
      const dUsd = w * this.st.eqRef - p.q * mid;
      if (Math.abs(dUsd) < C.minTradeUSD) continue;
      const side = dUsd > 0 ? 'buy' : 'sell';
      const closing = Math.abs(w) < 1e-12; // zerar usa a quantidade exata; o resto, o valor em US$
      const sw = closing ? book.sweepQty(side, Math.abs(p.q)) : book.sweep(side, Math.abs(dUsd));
      if (!sw.qty) { pending.push(s); continue; }
      const dq = side === 'buy' ? sw.qty : -sw.qty;
      const nq = p.q + dq;
      if (p.q === 0 || Math.sign(nq) !== Math.sign(p.q)) p.avg = sw.avg;           // abre ou vira
      else if (Math.abs(nq) > Math.abs(p.q)) p.avg = (p.avg * p.q + sw.avg * dq) / nq; // aumenta
      p.q = Math.abs(nq) * mid < 0.01 ? 0 : nq;
      this.st.cash -= dq * sw.avg;
      const usd = sw.qty * sw.avg, slip = Math.abs(sw.avg - mid) / mid;
      turnover += usd; cost += usd * slip;
      const fill = { ts: now, sym: s, side, usd, qty: sw.qty, px: sw.avg, mid, slip, cost_book: book.cost(usd), complete: sw.complete };
      this.fillCsv.append(fill);
      this.st.fills.unshift(fill); this.st.fills.length = Math.min(this.st.fills.length, 200);
      if (p.q === 0) delete this.st.pos[s]; else this.st.pos[s] = p;
      if (!sw.complete) pending.push(s); // livro raso: o resto fica para a proxima tentativa
    }
    this.st.pending = pending;
    return { turnover, cost, pending };
  }

  #scheduleRetry() {
    clearTimeout(this.retryTimer);
    if (this.st.pending?.length) this.retryTimer = setTimeout(() => this.retry(), 60_000);
  }

  /** nova tentativa das ordens adiadas (soma giro e custo ao ultimo rebalanceamento) */
  retry() {
    if (this.busy || !this.st.pending?.length || !this.st.theo) return this.#scheduleRetry();
    this.busy = true;
    try {
      const before = this.st.pending.slice();
      const ex = this.#execute(before);
      const done = before.filter((s) => !ex.pending.includes(s));
      if (done.length) {
        const row = this.st.rebalances[0];
        if (row) { row.turnover_usd += ex.turnover; row.cost_real_usd += ex.cost; }
        this.st.lastEqAfter = this.equityMark();
        log('MOMENTUM', `ordens adiadas executadas: ${done.join(',')} | giro $${ex.turnover.toFixed(0)} | custo $${ex.cost.toFixed(2)}` +
          (ex.pending.length ? ` | ainda adiados: ${ex.pending.join(',')}` : ''));
        this.save();
      }
    } catch (e) { log('ERRO', `momentum retry: ${e.stack}`); } finally { this.busy = false; }
    this.#scheduleRetry();
  }

  // ---------------------------------------------------------------- funding (market_stats)
  onStats(sym, ms) {
    const prev = this.stats.get(sym);
    this.stats.set(sym, ms);
    if (!ms.funding_timestamp || (prev && prev.funding_timestamp === ms.funding_timestamp)) return;
    const rate = +ms.funding_rate; // % por hora, positivo = comprados pagam
    const mark = +ms.mark_price;
    const p = this.st.pos[sym];
    if (p && ms.funding_timestamp > p.lastFundingTs && mark) {
      const pay = -p.q * mark * rate / 100;
      p.funding += pay; p.lastFundingTs = ms.funding_timestamp; this.st.cash += pay;
    }
    const th = this.st.theo, w = th?.hold?.[sym];
    if (w && ms.funding_timestamp > (th.lastFundingTs?.[sym] ?? th.T ?? 0)) {
      th.fundingPending += -w * th.gross * th.eq * rate / 100;
      (th.lastFundingTs ??= {})[sym] = ms.funding_timestamp;
    }
  }

  // ---------------------------------------------------------------- dashboard
  markCurve() {
    if (!this.st.theo) return;
    this.st.curve.push({ t: Date.now(), real: this.equityMark(), theo: this.theoMark() });
    if (this.st.curve.length > 20000) this.st.curve.splice(0, this.st.curve.length - 20000);
  }

  view() {
    const eq = this.equityMark(), th = this.st.theo;
    const hold = th?.hold ?? {};
    const positions = Object.entries(this.st.pos).map(([sym, p]) => {
      const mid = this.mid(sym);
      return { sym, q: p.q, side: p.q > 0 ? 'long' : 'short', avg: p.avg, mid, notional: p.q * mid, weight: p.q * mid / eq,
        target: (hold[sym] ?? 0) * (th?.gross ?? 0), upnl: p.q * (mid - p.avg), funding: p.funding };
    }).sort((a, b) => b.notional - a.notional);
    const curve = this.st.curve;
    let peak = -Infinity, dd = 0;
    for (const c of curve) { peak = Math.max(peak, c.real); dd = Math.min(dd, c.real / peak - 1); }
    const d = this.st.daily.filter((x) => Number.isFinite(x.retReal));
    const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    const fills = this.st.fills;
    return {
      ready: this.ready, warm: this.warm, startedAt: this.st.startedAt, startEquity: this.st.startEquity, equity: eq,
      theoEquity: this.theoMark(), maxDD: dd, cash: this.st.cash,
      gross: positions.reduce((a, p) => a + Math.abs(p.notional), 0) / eq,
      kelly: { full: this.kellyFull ?? this.kelly(), fraction: this.cfg.kellyFraction, cap: this.cfg.maxGrossLeverage,
        grossTarget: th?.gross ?? null, prior: this.prior && { n: this.prior.n, mean: this.prior.mean, sharpe: this.prior.sharpe, kelly: this.prior.kelly } },
      next: this.scheduledT(Date.now()) + DAY, lastT: this.st.lastT,
      stats: { days: d.length, retReal: mean(d.map((x) => x.retReal)), retTheo: mean(d.map((x) => x.retTheo).filter(Number.isFinite)),
        slip: fills.length ? fills.reduce((a, f) => a + f.slip * f.usd, 0) / fills.reduce((a, f) => a + f.usd, 0) : null,
        costReal: this.st.rebalances.reduce((a, r) => a + r.cost_real_usd, 0), costTheo: this.st.rebalances.reduce((a, r) => a + r.cost_theo_usd, 0) },
      positions, ranking: this.st.ranking, rebalances: this.st.rebalances.slice(0, 30), fills: fills.slice(0, 40),
      curve: curve.length > 1500 ? curve.filter((_, i) => i % Math.ceil(curve.length / 1500) === 0 || i === curve.length - 1) : curve,
      cfg: this.cfg,
    };
  }
}
