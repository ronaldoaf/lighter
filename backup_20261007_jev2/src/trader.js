import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BAR, log, readJSON, writeJSON, ensureDir, CsvLog } from '../../src/util.js';
import { JevClient, readEnv, PRICE_PER_INPUT_TOKEN } from './client.js';
import { indicators, to4h } from './indicators.js';

const H = 3_600_000;
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULTS = {
  enabled: true,
  model: 'jev-latest',
  topN: 3,               // ativos com maior forca de tendencia 4h·1d·7d
  rank: 'abs',           // 'abs' = |score| (alta ou baixa forte); 'up' = maior score
  liqMinUSD: 500000,     // volume 24h minimo para entrar no ranking
  initialEquity: 10000,
  positionFraction: 0.25, // notional por posicao = 25% do capital marcado (sem alavancagem)
  maxPositions: 4,
};

// Perguntas do usuario, em ingles (o JEV responde melhor em ingles), com criterios explicitos.
export const Q_ENTRY = {
  action: {
    type: 'choice',
    instructions: 'Given this data, which action has the highest profit potential: Long, Short or Skip?',
    criteria: {
      long: 'Long: open a long position now; price is more likely to rise enough to profit after the bid-ask spread.',
      short: 'Short: open a short position now; price is more likely to fall enough to profit after the bid-ask spread.',
      skip: 'Skip: no clear edge right now; do not open a position.',
    },
  },
};
export const Q_HOLD = {
  action: {
    type: 'choice',
    instructions: 'Given this data, should I keep the position open or close it?',
    criteria: {
      keep: 'Keep: the position still has profit potential in its direction.',
      close: 'Close: the move is exhausted or reversing; exit the position now.',
    },
  },
};

const CONTEXT = 'Lighter perpetual futures (trades 24/7, no trading fees; the only costs are the bid-ask spread and hourly funding). ' +
  'The decision is taken at the close of a 15-minute candle and every open position is reviewed again every 15 minutes. ' +
  'The asset was selected because it is among the strongest trends of the market (in either direction) by a trend-strength score.';

/**
 * jev-lighter-trader: a cada barra de 15m seleciona os topN ativos por forca de tendencia (conjunto curto 4h·1d·7d),
 * envia indicadores de 15m e 4h ao JEV e opera em paper conforme as respostas:
 *   sem posicao -> "Long, Short ou Skip?"  (abre no lado escolhido; ordem a mercado varrendo o livro gravado)
 *   com posicao -> "continuar ou fechar?"  (perguntado a cada barra, mesmo se o ativo saiu do top)
 * Estado em data/jev (state.json, decisions.csv, trades.csv). Chave TYPESAFE_KEY em jev-lighter-trader/.env.
 */
export class JevTrader {
  constructor({ cfg = {}, dataDir, recorder, bars, trend, classOf, client }) {
    this.cfg = { ...DEFAULTS, ...cfg };
    Object.assign(this, { recorder, bars, trend, classOf });
    this.client = client ?? new JevClient({ key: readEnv(path.join(HERE, '.env')).TYPESAFE_KEY, model: this.cfg.model });
    this.dir = ensureDir(path.join(dataDir, 'jev'));
    this.file = path.join(this.dir, 'state.json');
    this.st = readJSON(this.file, null) ?? {
      startedAt: Date.now(), cash: this.cfg.initialEquity, pos: {}, closed: [], decisions: [], curve: [], top: [], lastBar: null,
      calls: 0, errors: 0, inputTokens: 0,
    };
    this.stats = new Map();
    this.busy = false;
    this.decCsv = new CsvLog(path.join(this.dir, 'decisions.csv'), ['ts', 'bar', 'sym', 'kind', 'score', 'choice', 'p_long', 'p_short', 'p_skip',
      'p_keep', 'p_close', 'confidence', 'action', 'mid', 'pos_side', 'upnl_pct', 'input_tokens', 'error']);
    this.tradeCsv = new CsvLog(path.join(this.dir, 'trades.csv'), ['open_ts', 'close_ts', 'sym', 'side', 'notional', 'qty', 'entry', 'exit', 'mid_in', 'mid_out',
      'pnl_usd', 'pnl_pct', 'funding_usd', 'cost_usd', 'bars', 'score_in', 'p_in', 'p_close', 'why']);
  }

  save() { writeJSON(this.file, this.st); }

  mid(sym) {
    const t = this.recorder.books.get(sym)?.ready ? this.recorder.books.get(sym).top() : null;
    return t?.mid ?? this.bars.load(sym).at(-1)?.c ?? NaN;
  }

  equity() {
    let e = this.st.cash;
    for (const [s, p] of Object.entries(this.st.pos)) { const m = this.mid(s); e += p.q * (Number.isFinite(m) ? m : p.avg); }
    return e;
  }

  /** top N do ranking de forca (conjunto curto) no fechamento da barra */
  ranking() {
    const v = this.trend.view(0);
    if (!v.T || !v.rows.length) return { T: v.T, rows: [] };
    const rows = v.rows.filter((r) => r.sets?.curto && r.vol24 >= this.cfg.liqMinUSD)
      .map((r) => ({ sym: r.sym, cls: r.cls, price: r.price, vol24: r.vol24, vol: r.vol, ...r.sets.curto }))
      .sort((a, b) => (this.cfg.rank === 'up' ? b.score - a.score : Math.abs(b.score) - Math.abs(a.score)));
    rows.forEach((r, i) => { r.rank = i + 1; });
    return { T: v.T, rows, n: rows.length };
  }

  /** estado enviado ao JEV para um ativo */
  buildState(sym, tr, T, nRank, btc) {
    const b15 = this.bars.load(sym).filter((x) => x.t + BAR <= T).slice(-300);
    const b4 = to4h(this.trend.load(sym), T).slice(-250);
    const i15 = indicators(b15, '15-minute', 96, '24h'), i4 = indicators(b4, '4-hour', 42, '7-day');
    if (!i15 || !i4) return null;
    const book = this.recorder.books.get(sym), top = book?.ready ? book.top() : null;
    const fund = this.stats.get(sym);
    const st = {
      context: CONTEXT,
      asset: sym,
      asset_class: tr?.cls ?? this.classOf(sym),
      decision_time_utc: new Date(T).toISOString().slice(0, 16).replace('T', ' '),
      trend_strength: tr ? {
        score: { value: +tr.score.toFixed(1), meaning: 'trend strength from -100 (strong downtrend) to +100 (strong uptrend): mean of the 4h, 1d and 7d returns measured in standard deviations (clipped at +-2)' },
        rank: { value: tr.rank, meaning: `rank by absolute trend strength among ${nRank} liquid perps (1 = strongest)` },
        z_4h: { value: +tr.z[0].toFixed(2), meaning: '4h return in standard deviations' },
        z_1d: { value: +tr.z[1].toFixed(2), meaning: '1-day return in standard deviations' },
        z_7d: { value: +tr.z[2].toFixed(2), meaning: '7-day return in standard deviations' },
        ret_4h_pct: +(tr.r[0] * 100).toFixed(2), ret_1d_pct: +(tr.r[1] * 100).toFixed(2), ret_7d_pct: +(tr.r[2] * 100).toFixed(2),
        horizons_aligned: { value: `${tr.align}/${tr.nz}`, meaning: 'how many of the 3 horizons agree with the score sign' },
        r2_1d: { value: +tr.r2.toFixed(2), meaning: 'R-squared of log price vs time over the last day (1 = straight line)' },
        efficiency_1d: { value: +tr.er.toFixed(2), meaning: 'Kaufman efficiency over the last day (1 = no zig-zag)' },
      } : 'not among the strongest trends any more',
      market: {
        btc_trend_score: btc != null ? +btc.toFixed(1) : null,
        volume_24h_usd: tr ? Math.round(tr.vol24) : null,
        annualized_volatility_pct: tr ? +(tr.vol * 100).toFixed(0) : null,
        bid_ask_spread_pct: top ? +((top.ask - top.bid) / top.mid * 100).toFixed(4) : null,
        funding_rate_annual_pct: fund ? { value: +(+fund.funding_rate * 24 * 365).toFixed(1), meaning: 'positive = longs pay shorts' } : null,
      },
      indicators_15m: i15,
      indicators_4h: i4,
    };
    const p = this.st.pos[sym];
    if (p) {
      const m = this.mid(sym), dir = Math.sign(p.q);
      st.open_position = {
        side: dir > 0 ? 'long' : 'short',
        entry_price: +p.avg.toPrecision(8),
        current_price: +m.toPrecision(8),
        unrealized_pnl_pct: +((m / p.avg - 1) * dir * 100).toFixed(2),
        max_favorable_pct: +(p.mfe * 100).toFixed(2),
        max_adverse_pct: +(p.mae * 100).toFixed(2),
        time_in_position_hours: +((T - p.openBar) / H).toFixed(2),
        trend_score_at_entry: p.scoreIn,
      };
    }
    return st;
  }

  // ---------------------------------------------------------------- execucao paper
  #open(sym, dir, ctx) {
    const book = this.recorder.books.get(sym);
    if (!book?.ready) return 'sem livro';
    const eq = this.equity();
    if (Object.keys(this.st.pos).length >= this.cfg.maxPositions) return 'limite de posicoes';
    const usd = eq * this.cfg.positionFraction, mid = book.top().mid;
    const sw = book.sweep(dir > 0 ? 'buy' : 'sell', usd);
    if (!sw.qty) return 'livro vazio';
    const q = dir * sw.qty;
    this.st.cash -= q * sw.avg;
    this.st.pos[sym] = { q, avg: sw.avg, midIn: mid, openTs: Date.now(), openBar: ctx.T, scoreIn: ctx.score, pIn: ctx.p,
      notional: sw.qty * sw.avg, costIn: sw.qty * Math.abs(sw.avg - mid), funding: 0, mfe: 0, mae: 0, bars: 0,
      lastFundingTs: this.stats.get(sym)?.funding_timestamp ?? Date.now(), complete: sw.complete };
    log('JEV', `abre ${dir > 0 ? 'LONG' : 'SHORT'} ${sym} $${(sw.qty * sw.avg).toFixed(0)} @ ${sw.avg.toPrecision(6)} (score ${ctx.score?.toFixed(0)}, p ${ctx.p?.toFixed(2)})`);
    return dir > 0 ? 'abriu long' : 'abriu short';
  }

  #close(sym, why, pClose) {
    const p = this.st.pos[sym], book = this.recorder.books.get(sym);
    if (!p) return null;
    if (!book?.ready) return 'sem livro';
    const mid = book.top().mid, sw = book.sweepQty(p.q > 0 ? 'sell' : 'buy', Math.abs(p.q));
    if (!sw.qty) return 'livro vazio';
    const px = sw.complete ? sw.avg : (sw.avg * sw.qty + mid * (Math.abs(p.q) - sw.qty)) / Math.abs(p.q); // resto no mid (livro raso)
    this.st.cash += p.q * px;
    const pnl = p.q * (px - p.avg) + p.funding;
    const t = { open_ts: p.openTs, close_ts: Date.now(), sym, side: p.q > 0 ? 'long' : 'short', notional: p.notional, qty: Math.abs(p.q),
      entry: p.avg, exit: px, mid_in: p.midIn, mid_out: mid, pnl_usd: pnl, pnl_pct: pnl / p.notional, funding_usd: p.funding,
      cost_usd: p.costIn + Math.abs(p.q) * Math.abs(px - mid), bars: p.bars, score_in: p.scoreIn, p_in: p.pIn, p_close: pClose, why };
    this.tradeCsv.append(t);
    this.st.closed.unshift(t); this.st.closed.length = Math.min(this.st.closed.length, 300);
    delete this.st.pos[sym];
    log('JEV', `fecha ${t.side} ${sym} @ ${px.toPrecision(6)} | ${(t.pnl_pct * 100).toFixed(2)}% ($${pnl.toFixed(2)}) | ${why}`);
    return 'fechou';
  }

  // ---------------------------------------------------------------- ciclo da barra
  /** cur = inicio da barra atual (a barra que acabou de fechar comeca em cur - 15m) */
  async onBarClose(cur) {
    if (this.busy) return;
    if (this.trend.updatedAt == null) return log('JEV', 'aguardando candles 1h da tendencia');
    this.busy = true;
    try {
      const { T, rows, n } = this.ranking();
      if (!T || T !== cur) return log('AVISO', `JEV: tendencia sem a barra atual (T ${T ? new Date(T).toISOString().slice(11, 16) : '-'})`);
      if (this.st.lastBar === T) return;
      this.st.lastBar = T;
      // MFE/MAE e contagem de barras das posicoes
      for (const [s, p] of Object.entries(this.st.pos)) {
        const m = this.mid(s), r = (m / p.avg - 1) * Math.sign(p.q);
        if (Number.isFinite(r)) { p.mfe = Math.max(p.mfe, r); p.mae = Math.min(p.mae, r); }
        p.bars++;
      }
      const by = new Map(rows.map((r) => [r.sym, r]));
      const btc = by.get('BTC')?.score ?? this.trend.view(0).rows.find((r) => r.sym === 'BTC')?.sets?.curto?.score;
      // top N com historico suficiente para os indicadores (listagens novas sem 4h ficam de fora e entra o seguinte)
      const top = [], states = new Map();
      for (const r of rows) {
        if (top.length >= this.cfg.topN) break;
        const s = this.buildState(r.sym, r, T, n, btc);
        if (s) { top.push(r); states.set(r.sym, s); }
      }
      this.st.top = top.map((r) => ({ sym: r.sym, cls: r.cls, score: r.score, rank: r.rank, z: r.z, r: r.r, vol24: r.vol24 }));
      const jobs = [
        ...Object.keys(this.st.pos).map((sym) => ({ sym, kind: 'hold' })),
        ...top.filter((r) => !this.st.pos[r.sym]).map((r) => ({ sym: r.sym, kind: 'entry' })),
      ];
      await Promise.all(jobs.map(async (j) => {
        const tr = by.get(j.sym), state = j.kind === 'entry' ? states.get(j.sym) : this.buildState(j.sym, tr, T, n, btc);
        const rec = { ts: Date.now(), bar: T, sym: j.sym, kind: j.kind, score: tr?.score, mid: this.mid(j.sym) };
        const p = this.st.pos[j.sym];
        if (p) { rec.pos_side = p.q > 0 ? 'long' : 'short'; rec.upnl_pct = (rec.mid / p.avg - 1) * Math.sign(p.q); }
        if (!state) { rec.error = 'indicadores insuficientes'; rec.action = 'nada'; return this.#record(rec); }
        try {
          const res = await this.client.decide(state, j.kind === 'entry' ? Q_ENTRY : Q_HOLD);
          const a = res.answers.action;
          Object.assign(rec, { choice: a.choice, confidence: a.confidence, input_tokens: res.usage?.input_tokens, model: res.model,
            p_long: a.probabilities.long, p_short: a.probabilities.short, p_skip: a.probabilities.skip, p_keep: a.probabilities.keep, p_close: a.probabilities.close });
          this.st.inputTokens += res.usage?.input_tokens ?? 0; this.st.calls++;
          if (j.kind === 'entry') {
            rec.action = a.choice === 'skip' ? 'skip' : this.#open(j.sym, a.choice === 'long' ? 1 : -1, { T, score: tr?.score, p: a.probabilities[a.choice] });
          } else rec.action = a.choice === 'close' ? (this.#close(j.sym, 'JEV: fechar', a.probabilities.close) ?? 'nada') : 'mantem';
        } catch (e) {
          this.st.errors++; rec.error = e.message.slice(0, 160); rec.action = j.kind === 'hold' ? 'mantem (erro)' : 'nada (erro)';
          log('AVISO', `JEV ${j.sym}: ${e.message.slice(0, 160)}`);
        }
        this.#record(rec);
      }));
      this.st.curve.push({ t: T, eq: this.equity(), n: Object.keys(this.st.pos).length });
      if (this.st.curve.length > 6000) this.st.curve.splice(0, this.st.curve.length - 6000);
      const acts = this.st.decisions.filter((d) => d.bar === T).map((d) => `${d.sym}:${d.choice ?? 'erro'}`).join(' ');
      log('JEV', `barra ${new Date(T - BAR).toISOString().slice(11, 16)}: ${jobs.length} consultas | ${acts} | capital $${this.equity().toFixed(2)}`);
    } finally {
      this.busy = false;
      this.save();
    }
  }

  #record(rec) {
    this.decCsv.append(rec);
    this.st.decisions.unshift(rec); this.st.decisions.length = Math.min(this.st.decisions.length, 400);
  }

  // ---------------------------------------------------------------- funding (market_stats)
  onStats(sym, ms) {
    const prev = this.stats.get(sym);
    this.stats.set(sym, ms);
    if (!ms.funding_timestamp || (prev && prev.funding_timestamp === ms.funding_timestamp)) return;
    const p = this.st.pos[sym], mark = +ms.mark_price;
    if (p && ms.funding_timestamp > p.lastFundingTs && mark) {
      const pay = -p.q * mark * (+ms.funding_rate) / 100; // funding_rate em %/h, positivo = comprados pagam
      p.funding += pay; p.lastFundingTs = ms.funding_timestamp; this.st.cash += pay;
    }
  }

  // ---------------------------------------------------------------- dashboard
  view() {
    const eq = this.equity(), c = this.st.closed;
    const wins = c.filter((t) => t.pnl_usd > 0).length;
    const mean = (xs) => (xs.length ? xs.reduce((a, v) => a + v, 0) / xs.length : null);
    let peak = -Infinity, dd = 0;
    for (const x of this.st.curve) { peak = Math.max(peak, x.eq); dd = Math.min(dd, x.eq / peak - 1); }
    const pos = Object.entries(this.st.pos).map(([sym, p]) => {
      const m = this.mid(sym), last = this.st.decisions.find((d) => d.sym === sym && d.kind === 'hold' && d.choice);
      return { sym, side: p.q > 0 ? 'long' : 'short', notional: p.notional, avg: p.avg, mid: m, upnl: p.q * (m - p.avg) + p.funding,
        upnlPct: (m / p.avg - 1) * Math.sign(p.q), funding: p.funding, openTs: p.openTs, bars: p.bars, scoreIn: p.scoreIn, pIn: p.pIn,
        mfe: p.mfe, mae: p.mae, lastKeep: last?.p_keep ?? null };
    });
    return {
      cfg: this.cfg, startedAt: this.st.startedAt, lastBar: this.st.lastBar, busy: this.busy,
      equity: eq, initial: this.cfg.initialEquity, pnl: eq - this.cfg.initialEquity, dd,
      trades: c.length, winRate: c.length ? wins / c.length : null, avgPct: mean(c.map((t) => t.pnl_pct)), sumUsd: c.reduce((a, t) => a + t.pnl_usd, 0),
      longs: c.filter((t) => t.side === 'long').length, shorts: c.filter((t) => t.side === 'short').length,
      calls: this.st.calls, errors: this.st.errors, inputTokens: this.st.inputTokens, cost: this.st.inputTokens * PRICE_PER_INPUT_TOKEN,
      top: this.st.top, pos, decisions: this.st.decisions.slice(0, 150), closed: c.slice(0, 150),
      curve: this.st.curve.map((x) => ({ t: x.t, eq: x.eq })),
    };
  }
}
