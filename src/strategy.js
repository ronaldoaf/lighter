import path from 'node:path';
import { BAR, log, readJSON, writeJSON, CsvLog, ensureDir } from './util.js';
import { kellyFraction, summary } from './kelly.js';

/**
 * Paper trading da estrategia de ACHADOS_estrategias_volume.md (fade de pico de volume, so short), replicando
 * search_fade_exec.engine com dados ao vivo:
 *
 *  (cfg.preFilter, fade C2: lado/classe/custo filtram ANTES do ranking e o top N sai dos aptos)
 *  SINAL (fechamento da barra k, candles REST): elegiveis = liq >= config.liqMinUSD (500k) & corpo >= 1.5 ATR14 & volume >= 3x media 1d;
 *        top 1 por corpo entre TODOS os perps; opera se for barra de alta (short), classe cripto/acoes,
 *        ativo livre e custo por perna no livro <= 0.15%.
 *  SETUP (barras k+1..k+8, ao vivo): cada candle contrario (de baixa) arma o gatilho na sua minima (max 3);
 *        "hi" = maior maxima desde k-3 = stop.
 *  ENTRADA: negocio abaixo do gatilho -> vende no gatilho (stop-limite); se a barra abre abaixo (gap), cancela.
 *        risco = (stop - E)/E precisa ser >= 2%, senao descarta.
 *  SAIDA: stop (inclusive na barra de entrada), alvo = E - 1.5 x risco (a partir da barra seguinte), ou
 *        fechamento da 96a barra (24h).
 *
 * Dois resultados por trade:
 *  - "teorico": precos do backtest (gatilho/stop/alvo) - custo medido no livro no sinal x pernas + funding;
 *  - "real":    entrada e saidas a mercado varrendo o livro gravado naquele instante (alvo = limite, sem custo)
 *               + funding. O capital do paper evolui pelo resultado real.
 */
export class Strategy {
  constructor({ cfg, sizing, dataDir, recorder, bars, live, classOf, name = 'fade', sub = null }) {
    this.cfg = cfg; this.sz = sizing; this.rec = recorder; this.bars = bars; this.live = live; this.classOf = classOf;
    this.name = name; this.tag = sub ? `[${name}] ` : '';
    if (sub) dataDir = ensureDir(path.join(dataDir, sub)); // instancia paralela (ex.: fade C2): estado/CSVs proprios
    this.file = path.join(dataDir, 'state.json');
    this.signalsCsv = new CsvLog(path.join(dataDir, 'signals.csv'),
      ['bar', 'sym', 'cls', 'dir', 'body_atr', 'vol_ratio', 'liq_usd', 'cost_1k', 'cost_order', 'order_usd', 'cost_calm_1k', 'decision', 'reason']);
    this.tradesCsv = new CsvLog(path.join(dataDir, 'trades.csv'),
      ['sym', 'cls', 'side', 'signal_bar', 'fill_ts', 'exit_ts', 'why', 'E', 'stop', 'tgt', 'exit_theo', 'entry_real', 'exit_real',
        'risk_pct', 'qty', 'notional', 'risk_usd', 'risk_frac', 'kelly_full', 'cost_signal', 'cost_calm_1k', 'slip_entry', 'slip_exit',
        'funding_usd', 'R_theo_gross', 'R_theo_net', 'R_real', 'pnl_real', 'equity_after', 'bars_held']);
    const prior = readJSON(path.resolve(sizing.kellyPriorFile), null);
    this.prior = prior?.r || [];
    if (!prior) this.log('AVISO', `sem ${sizing.kellyPriorFile}: rode scripts/export_kelly_prior.py (Kelly so com trades do paper)`);
    this.priorInfo = prior ? { n: prior.n, mean: prior.mean, win: prior.win, kelly: prior.kelly, kelly_IS: prior.kelly_IS, kelly_OOS: prior.kelly_OOS } : null;

    const s = readJSON(this.file, null);
    this.st = s || { equity: sizing.initialEquity, startEquity: sizing.initialEquity, startedAt: Date.now(),
      setups: {}, positions: {}, closed: [], signals: [], curve: [{ t: Date.now(), equity: sizing.initialEquity, mtm: sizing.initialEquity }] };
    this.st.lastScan ??= null;
    this.stats = new Map(); // sym -> ultimo market_stats
    this.now = () => Date.now(); // injetavel nos testes (replay historico)
    this.#recomputeKelly();
  }

  save() { writeJSON(this.file, this.st); }

  log(level, msg, extra) { log(level, this.tag + msg, extra); }

  busy(sym) { return !!(this.st.setups[sym] || this.st.positions[sym]); }

  #recomputeKelly() {
    this.kellyFull = kellyFraction(this.prior, this.sz.kellyPriorWeight, this.st.closed.map((t) => t.R_real).filter(Number.isFinite));
    this.riskFrac = Math.min(this.sz.kellyFraction * this.kellyFull, this.sz.maxRiskPerTrade);
  }

  openRisk() {
    return Object.values(this.st.positions).reduce((a, p) => a + p.riskUSD, 0) / this.st.equity;
  }

  gross() { return Object.values(this.st.positions).reduce((a, p) => a + p.notional, 0); }

  /** notional previsto para o filtro de custo no sinal (stop medio do backtest ~3.8%) */
  plannedNotional() {
    const n = (this.st.equity * this.riskFrac) / 0.038;
    return Math.max(10, Math.min(n, this.sz.maxLeveragePerTrade * this.st.equity));
  }

  // ---------------------------------------------------------------- sinal (fechamento da barra, REST)
  scan(k, symbols) {
    const C = this.cfg;
    const cands = [];
    for (const sym of symbols) {
      const f = this.bars.features(sym, k);
      if (!f || !(f.liq >= C.liqMinUSD) || !(f.body >= C.bodyMinATR) || !(f.vr >= C.volMinRatio)) continue;
      cands.push({ sym, cls: this.classOf(sym), ...f });
      this.rec.markHot(sym);
    }
    cands.sort((a, b) => b.body - a.body);
    if (C.preFilter) { // C2: lado, classe e custo entram ANTES do ranking (o top N sai so dos aptos)
      const order = this.plannedNotional();
      const apt = cands.filter((c) => {
        const side = c.dir > 0 ? 'short' : c.dir < 0 ? 'long' : null;
        const book = this.rec.books.get(c.sym);
        const cost = !book?.ready ? NaN : C.costFilterSize === 'order' ? book.cost(order) : book.cost(1000);
        return side && C.sides.includes(side) && C.classes.includes(c.cls) && Number.isFinite(cost) && cost <= C.maxCostPerLeg;
      });
      cands.length = 0; cands.push(...apt);
    }
    this.st.lastScan = { k, at: Date.now(), n: symbols.length, cands: cands.slice(0, 12).map((c) => ({
      sym: c.sym, cls: c.cls, dir: c.dir, body: c.body, vr: c.vr, liq: c.liq })) };
    for (const top of cands.slice(0, C.topN)) this.#signal(k, top);
    this.save();
  }

  #signal(k, f) {
    const C = this.cfg;
    const side = f.dir > 0 ? 'short' : f.dir < 0 ? 'long' : null;
    const book = this.rec.books.get(f.sym);
    const order = this.plannedNotional();
    const c1k = book?.ready ? book.cost(1000) : NaN;
    const cOrder = book?.ready ? book.cost(order) : NaN;
    const cFilter = C.costFilterSize === 'order' ? cOrder : c1k;
    let reason = null;
    if (!side || !C.sides.includes(side)) reason = `${side ?? 'doji'} desligado`;
    else if (!C.classes.includes(f.cls)) reason = `classe ${f.cls}`;
    else if (this.busy(f.sym)) reason = 'ativo ocupado';
    else if (!book?.ready) reason = 'sem livro';
    else if (!Number.isFinite(cFilter)) reason = 'livro raso p/ o tamanho';
    else if (cFilter > C.maxCostPerLeg) reason = `custo ${(cFilter * 100).toFixed(3)}% > ${(C.maxCostPerLeg * 100).toFixed(2)}%`;
    else if (this.now() >= k + 2 * BAR) reason = 'atraso (barra k+1 ja fechou)';
    const sig = { k, at: Date.now(), sym: f.sym, cls: f.cls, side, body: f.body, vr: f.vr, liq: f.liq, c1k, cOrder, order,
      calm: this.rec.calmCost(f.sym), decision: reason ? 'ignorado' : 'setup', reason: reason || 'aguardando contra-candle' };
    this.st.signals.unshift(sig);
    this.st.signals.length = Math.min(this.st.signals.length, 300);
    this.signalsCsv.append({ bar: new Date(k).toISOString(), sym: f.sym, cls: f.cls, dir: side, body_atr: f.body, vol_ratio: f.vr,
      liq_usd: f.liq, cost_1k: c1k, cost_order: cOrder, order_usd: order, cost_calm_1k: sig.calm, decision: sig.decision, reason: sig.reason });
    this.rec.snapshot(f.sym, 'signal', Date.now(), { k, side, decision: sig.decision });
    this.log('SINAL', `${f.sym} ${side} corpo ${f.body.toFixed(2)} ATR vol ${f.vr.toFixed(1)}x custo ${(cOrder * 100).toFixed(3)}% -> ${sig.decision}${reason ? ': ' + reason : ''}`);
    if (reason) return;

    const s = f.dir; // sinal da barra; posicao d = -s (fade)
    this.st.setups[f.sym] = { sym: f.sym, cls: f.cls, k, s, d: -s, hi: s > 0 ? f.hi4 : f.lo4, ncc: 0, touched: false, trig: null,
      end: k + C.setupWindowBars * BAR, created: Date.now(), cSignal: cOrder, c1kSignal: c1k, calm: sig.calm, sig };
    this.rec.markHot(f.sym);
  }

  // ---------------------------------------------------------------- barras ao vivo (fechamento)
  onBar(sym, bar, t, complete) {
    if (!this.ready) return;
    const su = this.st.setups[sym];
    if (su && t > su.k) this.#setupBar(su, bar, t, complete);
    const p = this.st.positions[sym];
    if (p && t >= p.fillBar) {
      p.lastBar = t;
      if (bar) p.lastClose = bar.c;
      if (t >= p.fillBar + this.cfg.timeoutBars * BAR) {
        const px = bar?.c ?? p.lastClose ?? this.live.lastPx.get(sym);
        this.#exit(p, 'timeout', px, t + BAR);
      } else this.save();
    }
  }

  #setupBar(su, bar, t, complete) {
    if (!complete) return this.#cancel(su, 'dados incompletos (app iniciou no meio da janela)');
    if (!bar) return this.#cancel(su, 'barra sem negocios');
    su.hi = su.s > 0 ? Math.max(su.hi, bar.h) : Math.min(su.hi, bar.l);
    if (su.d * (bar.c - bar.o) > 0) { // candle contra o movimento do sinal
      su.ncc++;
      if (su.ncc > this.cfg.maxCounterCandles) return this.#cancel(su, `mais de ${this.cfg.maxCounterCandles} contra-candles`);
      su.touched = true; su.trig = su.s > 0 ? bar.l : bar.h; su.trigBar = t;
      this.log('SETUP', `${su.sym} gatilho armado em ${su.trig} (stop ${su.hi}, risco ${(Math.abs(su.hi - su.trig) / su.trig * 100).toFixed(2)}%)`);
    }
    if (t >= su.end) return this.#cancel(su, `janela de ${this.cfg.setupWindowBars} barras sem rompimento`);
    this.save();
  }

  /** sinal do setup na lista (apos recarregar o state.json, su.sig e st.signals deixam de ser o mesmo objeto) */
  #sig(su) {
    return this.st.signals.find((s) => s.k === su.k && s.sym === su.sym) ?? su.sig;
  }

  #cancel(su, why) {
    delete this.st.setups[su.sym];
    const sig = this.#sig(su);
    sig.decision = 'cancelado'; sig.reason = why;
    this.log('SETUP', `${su.sym} cancelado: ${why}`);
    this.save();
  }

  // ---------------------------------------------------------------- negocios ao vivo
  onTrade(sym, px, ts, t, first) {
    if (!this.ready) return;
    const su = this.st.setups[sym];
    if (su?.touched && t > su.trigBar) {
      const beyond = su.s > 0 ? px < su.trig : px > su.trig;
      if (beyond) {
        if (first) this.#cancel(su, 'barra abriu alem do gatilho (gap)');
        else this.#fill(su, ts, t);
      }
    }
    const p = this.st.positions[sym];
    if (!p || ts < p.fillTs) return;
    const d = p.d;
    const hitStop = d > 0 ? px <= p.stop : px >= p.stop;
    if (hitStop) return this.#exit(p, 'stop', first && t > p.fillBar ? px : p.stop, ts);
    if (t > p.fillBar) {
      const hitTgt = d > 0 ? px >= p.tgt : px <= p.tgt;
      if (hitTgt) return this.#exit(p, 'alvo', first ? px : p.tgt, ts);
    }
  }

  #fill(su, ts, t) {
    const { sym, d } = su;
    const E = su.trig, stop = su.hi;
    const riskPct = d * (E - stop) / E;
    delete this.st.setups[sym];
    const sig = this.#sig(su);
    if (!(riskPct >= this.cfg.minRiskPct)) {
      sig.decision = 'descartado'; sig.reason = `risco ${(riskPct * 100).toFixed(2)}% < ${this.cfg.minRiskPct * 100}%`;
      this.log('SETUP', `${sym} rompeu, mas ${sig.reason}`);
      return this.save();
    }
    const eq = this.st.equity;
    const riskFrac = Math.min(this.riskFrac, this.sz.maxOpenRisk - this.openRisk());
    let notional = (eq * riskFrac) / riskPct;
    notional = Math.min(notional, this.sz.maxLeveragePerTrade * eq, this.sz.maxGrossLeverage * eq - this.gross());
    if (!(riskFrac > 0) || !(notional >= 10)) {
      sig.decision = 'descartado'; sig.reason = 'limite de risco/alavancagem aberto';
      this.log('SETUP', `${sym} rompeu, mas ${sig.reason}`);
      return this.save();
    }
    const book = this.rec.books.get(sym);
    const side = d < 0 ? 'sell' : 'buy';
    const sw = book?.ready ? book.sweep(side, notional) : null;
    const entryReal = sw && Number.isFinite(sw.avg) ? sw.avg : E;
    const qty = sw?.qty > 0 ? sw.qty : notional / E;
    const p = {
      sym, cls: su.cls, d, side: d < 0 ? 'short' : 'long', k: su.k, fillBar: t, fillTs: ts, E, stop, riskPct,
      tgt: E + d * this.cfg.RR * Math.abs(E - stop), entryReal, qty, notional: qty * entryReal, riskUSD: qty * E * riskPct,
      riskFrac: (qty * E * riskPct) / eq, kellyFull: this.kellyFull, cSignal: su.cSignal, c1kSignal: su.c1kSignal, calm: su.calm,
      slipEntry: d * (entryReal - E) / E, bookFull: !!sw?.complete, funding: 0,
      lastFundingTs: this.stats.get(sym)?.funding_timestamp ?? ts, lastClose: E, lastBar: t,
    };
    this.st.positions[sym] = p;
    sig.decision = 'aberto'; sig.reason = `${p.side} @ ${E}`;
    this.rec.snapshot(sym, 'fill', ts, { E, entryReal, stop, tgt: p.tgt, qty });
    this.rec.markHot(sym, (this.cfg.timeoutBars + 8) * BAR);
    this.log('ENTRADA', `${sym} ${p.side} E=${E} real=${entryReal.toPrecision(6)} stop=${stop} alvo=${p.tgt.toPrecision(6)} risco ${(riskPct * 100).toFixed(2)}% notional $${p.notional.toFixed(0)} (${(p.riskFrac * 100).toFixed(2)}% do capital)`);
    this.save();
  }

  #exit(p, why, pxTheo, ts) {
    const book = this.rec.books.get(p.sym);
    let exitReal = pxTheo;
    if (why !== 'alvo' && book?.ready) { // stop/timeout a mercado; alvo = ordem limite (maker, sem custo)
      const sw = book.sweepQty(p.d < 0 ? 'buy' : 'sell', p.qty);
      if (Number.isFinite(sw.avg)) exitReal = sw.avg;
    }
    const RtheoGross = p.d * (pxTheo - p.E) / Math.abs(p.E - p.stop);
    const legs = why === 'alvo' ? 1 : 2;
    const fundR = p.funding / p.riskUSD;
    const pnl = p.d * p.qty * (exitReal - p.entryReal) + p.funding;
    this.st.equity += pnl;
    const tr = {
      sym: p.sym, cls: p.cls, side: p.side, signal_bar: p.k, fill_ts: p.fillTs, exit_ts: ts, why, E: p.E, stop: p.stop, tgt: p.tgt,
      exit_theo: pxTheo, entry_real: p.entryReal, exit_real: exitReal, risk_pct: p.riskPct, qty: p.qty, notional: p.notional,
      risk_usd: p.riskUSD, risk_frac: p.riskFrac, kelly_full: p.kellyFull, cost_signal: p.cSignal, cost_calm_1k: p.calm,
      slip_entry: p.slipEntry, slip_exit: -p.d * (exitReal - pxTheo) / pxTheo, /* slippage positivo = contra nos */ funding_usd: p.funding,
      R_theo_gross: RtheoGross, R_theo_net: RtheoGross - p.cSignal * legs / p.riskPct + fundR,
      R_real: pnl / p.riskUSD, pnl_real: pnl, equity_after: this.st.equity, bars_held: Math.round((ts - p.fillBar) / BAR),
    };
    delete this.st.positions[p.sym];
    this.st.closed.push(tr);
    this.tradesCsv.append({ ...tr, signal_bar: new Date(p.k).toISOString(), fill_ts: new Date(p.fillTs).toISOString(), exit_ts: new Date(ts).toISOString() });
    this.rec.snapshot(p.sym, 'exit', ts, { why, pxTheo, exitReal });
    this.#recomputeKelly();
    this.markCurve();
    this.log('SAIDA', `${p.sym} ${why} teorico ${tr.R_theo_net.toFixed(2)}R real ${tr.R_real.toFixed(2)}R ($${pnl.toFixed(2)}) capital $${this.st.equity.toFixed(2)}`);
    this.save();
  }

  // ---------------------------------------------------------------- funding (market_stats)
  onStats(sym, ms) {
    const prev = this.stats.get(sym);
    this.stats.set(sym, ms);
    const p = this.ready && this.st.positions[sym];
    if (!p || !ms.funding_timestamp || ms.funding_timestamp <= p.lastFundingTs || ms.funding_timestamp <= p.fillTs) return;
    if (prev && prev.funding_timestamp === ms.funding_timestamp) return;
    const rate = +ms.funding_rate; // % por hora, positivo = comprados pagam
    const mark = +ms.mark_price || p.lastClose;
    const pay = -p.d * p.qty * mark * rate / 100;
    p.funding += pay; p.lastFundingTs = ms.funding_timestamp;
    this.log('FUNDING', `${sym} ${rate}%/h -> ${pay >= 0 ? '+' : ''}$${pay.toFixed(3)}`);
    this.save();
  }

  // ---------------------------------------------------------------- recuperacao apos reinicio
  /** setups antigos sao cancelados; posicoes sao avancadas pelos candles REST do periodo em que o app ficou parado */
  recover() {
    for (const su of Object.values(this.st.setups)) this.#cancel(su, 'reinicio do app');
    for (const s of this.st.signals) if (s.decision === 'setup') { s.decision = 'cancelado'; s.reason = 'reinicio do app'; }
    for (const p of Object.values(this.st.positions)) {
      const bars = this.bars.load(p.sym).filter((b) => b.t > p.lastBar);
      for (const b of bars) {
        if (!this.st.positions[p.sym]) break;
        const d = p.d;
        if (d > 0 ? b.l <= p.stop : b.h >= p.stop) { this.#exit(p, 'stop', d > 0 ? Math.min(b.o, p.stop) : Math.max(b.o, p.stop), b.t + BAR); break; }
        if (b.t > p.fillBar && (d > 0 ? b.h >= p.tgt : b.l <= p.tgt)) { this.#exit(p, 'alvo', d > 0 ? Math.max(b.o, p.tgt) : Math.min(b.o, p.tgt), b.t + BAR); break; }
        p.lastBar = b.t; p.lastClose = b.c;
        if (b.t >= p.fillBar + this.cfg.timeoutBars * BAR) { this.#exit(p, 'timeout', b.c, b.t + BAR); break; }
      }
      if (this.st.positions[p.sym]) this.log('INFO', `posicao ${p.sym} retomada (ultima barra ${new Date(p.lastBar).toISOString()})`);
    }
    this.ready = true;
    this.save();
  }

  // ---------------------------------------------------------------- dashboard
  mark(p) {
    const book = this.rec.books.get(p.sym);
    const px = book?.top()?.mid ?? this.live.lastPx.get(p.sym) ?? p.lastClose;
    const upnl = p.d * p.qty * (px - p.entryReal) + p.funding;
    return { px, upnl, uR: upnl / p.riskUSD };
  }

  markCurve() {
    const mtm = this.st.equity + Object.values(this.st.positions).reduce((a, p) => a + this.mark(p).upnl, 0);
    this.st.curve.push({ t: Date.now(), equity: this.st.equity, mtm });
    if (this.st.curve.length > 20000) this.st.curve.splice(0, this.st.curve.length - 20000);
  }

  view() {
    const closed = this.st.closed;
    const real = closed.map((t) => t.R_real), theo = closed.map((t) => t.R_theo_net);
    const curve = this.st.curve;
    let peak = -Infinity, dd = 0;
    for (const c of curve) { peak = Math.max(peak, c.mtm); dd = Math.min(dd, c.mtm / peak - 1); }
    const positions = Object.values(this.st.positions).map((p) => ({ ...p, ...this.mark(p) }));
    const mtm = this.st.equity + positions.reduce((a, p) => a + p.upnl, 0);
    const byClass = {};
    for (const t of closed) {
      const c = (byClass[t.cls] ??= { n: 0, R: 0, pnl: 0 });
      c.n++; c.R += t.R_real; c.pnl += t.pnl_real;
    }
    const slip = closed.filter((t) => Number.isFinite(t.slip_entry));
    return {
      equity: this.st.equity, startEquity: this.st.startEquity, mtm, startedAt: this.st.startedAt, maxDD: dd,
      kelly: { full: this.kellyFull, fraction: this.sz.kellyFraction, riskFrac: this.riskFrac, prior: this.priorInfo,
        liveN: real.length, openRisk: this.openRisk(), gross: this.gross() / this.st.equity },
      stats: { real: summary(real), theo: summary(theo), byClass,
        slipEntry: slip.length ? slip.reduce((a, t) => a + t.slip_entry, 0) / slip.length : null,
        costSignal: closed.length ? closed.reduce((a, t) => a + (t.cost_signal || 0), 0) / closed.length : null },
      positions, setups: Object.values(this.st.setups), signals: this.st.signals.slice(0, 60),
      closed: closed.slice(-100).reverse(), curve: curve.length > 1500 ? curve.filter((_, i) => i % Math.ceil(curve.length / 1500) === 0 || i === curve.length - 1) : curve,
      lastScan: this.st.lastScan,
    };
  }
}
