import path from 'node:path';
import { log, readJSON, writeJSON, ensureDir, CsvLog, sleep } from './util.js';

const MIN = 60_000, H = 3_600_000;
const BAPI = 'https://fapi.binance.com/fapi/v1';

/** Regra congelada (DayTraderRockStar.md secao 7; referencia scripts/quadturb.py, backtest scripts/study_quad2_final.py). Nao mudar depois de iniciado. */
export const QT = {
  titulo: 'Quad em turbulência', secao: 'DTRS 7',
  regra: 'compra no 1º candle de 1m (Binance) em que os 4 estocásticos (%D 9-3, 14-3, 40-4, 60-10) ficam abaixo de 20, se o ATR(14) em bp ≥ 2,5× a média ' +
    'das 43.200 barras anteriores (30 dias); fora das janelas de notícia de NY; sai 60 min depois, sem stop; uma posição por ativo; disjuntor: trades do ativo ' +
    'fechados nas últimas 24h somando ≤ −10% → sem entradas nele por 72h',
  stoch: [[9, 3], [14, 3], [40, 4], [60, 10]], nivel: 20, thr: 2.5, win: 43200, minp: 10800, hold: 60, gapMin: 30,
  perda: 0.10, janelaH: 24, pausaH: 72, K: 5,
  news: [[505, 525], [568, 580], [955, 965], [1015, 1085]], // minutos do dia em NY: 8:25-8:45, 9:28-9:40, 15:55-16:05, 16:55-18:05
  syms: ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'LINK', 'NEAR', 'AAVE', 'TRX', 'DOGE', 'AVAX', 'LTC', 'ADA', 'UNI'],
  nucleo: ['BTC', 'ETH', 'SOL', 'XRP'],
  baratos: ['BTC', 'ETH', 'SOL', 'XRP', 'BNB', 'LINK', 'NEAR', 'AAVE', 'TRX'], // custo Lighter <= 3 bp/perna (US$5k)
  // backtest (9 baratos, K = 5): bp liquido por trade 2024+ na Binance e 2025-26 nos fechamentos da Lighter (atraso 1 min); trades/ano; Sharpe 2024+
  esperado: { bp: 16.0, bpLighter: 11.8, trAno: 990, sharpe: 1.93, sharpeLighter: 1.38 },
};

/** media movel de janela fixa identica bit a bit ao rolling(w, min_periods).mean() do pandas
 *  (soma corrente com Kahan, compensacoes separadas para entrada e saida, remove antes de adicionar, valores iguais em sequencia) */
export class RollMean {
  constructor(w, minp) {
    Object.assign(this, { w, minp, buf: new Float64Array(w), len: 0, head: 0, nobs: 0, sum: 0, neg: 0, ca: 0, cr: 0, same: 0, prev: NaN, out: NaN });
  }
  push(v) {
    if (this.len === this.w) {
      const old = this.buf[this.head];
      this.buf[this.head] = v; this.head = (this.head + 1) % this.w;
      if (old === old) {
        this.nobs--;
        const y = -old - this.cr, t = this.sum + y;
        this.cr = t - this.sum - y; this.sum = t;
        if (old < 0 || Object.is(old, -0)) this.neg--;
      }
    } else this.buf[this.len++] = v;
    if (v === v) {
      this.nobs++;
      const y = v - this.ca, t = this.sum + y;
      this.ca = t - this.sum - y; this.sum = t;
      if (v < 0 || Object.is(v, -0)) this.neg++;
      this.same = v === this.prev ? this.same + 1 : 1;
      this.prev = v;
    }
    let r = NaN;
    if (this.nobs >= this.minp && this.nobs > 0) {
      r = this.sum / this.nobs;
      if (this.same >= this.nobs) r = this.prev;
      else if (this.neg === 0 && r < 0) r = 0;
      else if (this.neg === this.nobs && r > 0) r = 0;
    }
    return (this.out = r);
  }
}

// minuto do dia em Nova York da abertura da barra (cache por hora UTC; o fuso so muda na hora cheia)
const etFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' });
const etCache = new Map();
export function etMinute(t) {
  const h0 = Math.floor(t / H) * H;
  let off = etCache.get(h0);
  if (off === undefined) {
    const p = Object.fromEntries(etFmt.formatToParts(new Date(h0)).map((x) => [x.type, x.value]));
    off = (+p.hour % 24) * 60 + +p.minute;
    etCache.set(h0, off);
    if (etCache.size > 5000) etCache.delete(etCache.keys().next().value);
  }
  return off + Math.floor((t - h0) / MIN);
}

/** indicadores e sinal barra a barra (mesmas contas de scripts/quadturb.signals, alimentado desde a primeira barra) */
export class QTCalc {
  constructor(R = QT) {
    this.R = R; this.n = 0; this.lastT = -Infinity;
    this.hs = []; this.ls = [];
    this.d = R.stoch.map(([, m]) => new RollMean(m, m));
    this.atr = NaN; this.prevC = NaN; this.a = 1 / 14;
    this.mu = new RollMean(R.win, R.minp);
    this.prevQuad = false;
    this.last = null;
  }
  push({ t, h, l, c }) {
    const R = this.R, maxN = R.stoch.at(-1)[0];
    this.hs.push(h); this.ls.push(l);
    if (this.hs.length > maxN) { this.hs.shift(); this.ls.shift(); }
    const D = R.stoch.map(([n], j) => {
      let k = NaN;
      if (this.hs.length >= n) {
        let hh = -Infinity, ll = Infinity;
        for (let i = this.hs.length - n; i < this.hs.length; i++) { if (this.hs[i] > hh) hh = this.hs[i]; if (this.ls[i] < ll) ll = this.ls[i]; }
        const rng = hh - ll;
        k = rng > 0 ? 100 * (c - ll) / rng : 50;
      }
      return this.d[j].push(k);
    });
    const quad = D.every((x) => x < R.nivel);
    const q1 = quad && !this.prevQuad;
    this.prevQuad = quad;
    // ATR de Wilder: ewm(alpha=1/14, adjust=False) do pandas, primeiro valor = TR da primeira barra
    const tr = Number.isFinite(this.prevC) ? Math.max(h - l, Math.max(Math.abs(h - this.prevC), Math.abs(l - this.prevC))) : Math.max(h - l, Math.max(Math.abs(h - c), Math.abs(l - c)));
    if (!Number.isFinite(this.atr)) this.atr = tr;
    else if (this.atr !== tr) this.atr = ((1 - this.a) * this.atr + this.a * tr) / ((1 - this.a) + this.a);
    this.prevC = c;
    const atrBp = this.atr / c * 1e4;
    const mu = this.mu.out; // media das barras anteriores (shift(1))
    this.mu.push(atrBp);
    const rel = atrBp / mu;
    const em = etMinute(t);
    const ok = !R.news.some(([a, b]) => em >= a && em < b);
    const sig = q1 && rel >= R.thr && ok;
    this.n++; this.lastT = t;
    return (this.last = { t, c, d: D, quad, atrBp, rel, ok, sig });
  }
}

async function getJSON(url, ms = 15000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const kbar = (k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
const iso = (t) => new Date(t).toISOString();

/**
 * Quad em turbulencia no modo sombra (sem capital): candles de 1m da Binance USDT-M de cada ativo, a cada minuto (3 s depois da virada).
 * Aquecimento: 31 dias de candles na partida (limite de peso da Binance: pedidos de 1000 barras espaçados). O sinal abre uma posicao
 * sombra (preco do livro da Lighter, como os outros candidatos) com saida 60 min depois. Tambem registra o resultado "teorico" com os
 * fechamentos da Binance (60 barras depois, como o backtest) para conferir a paridade ao vivo.
 * Estado em data/shadow/quad_turb/state.json; signals.csv (todo sinal, aberto ou nao, com o motivo) e theo.csv.
 */
export class QuadTurb {
  constructor({ dataDir, shadow, R = QT, fetchJSON = getJSON, gapMs = 250 }) {
    Object.assign(this, { shadow, R, fetchJSON, gapMs });
    this.dir = ensureDir(path.join(dataDir, 'shadow', 'quad_turb'));
    this.file = path.join(this.dir, 'state.json');
    this.st = readJSON(this.file, null) ?? { startedAt: Date.now(), pause: {}, theo: [], sigs: [], done: [] };
    this.sigCsv = new CsvLog(path.join(this.dir, 'signals.csv'),
      ['t', 'sym', 'close_binance', 'd9', 'd14', 'd40', 'd60', 'atr_bp', 'atr_rel', 'abriu', 'motivo', 'abertas', 'trade_id']);
    this.theoCsv = new CsvLog(path.join(this.dir, 'theo.csv'), ['t_in', 'sym', 'entry_binance', 't_out', 'exit_binance', 'bp_binance', 'motivo', 'trade_id']);
    this.calc = new Map(); this.lastT = new Map(); this.bsym = new Map();
    this.warming = null; this.busy = false; this.lastRun = 0; this.err = null; this.updatedAt = null;
  }

  save() { writeJSON(this.file, this.st); }
  log(msg) { log('SOMBRA', `quad turbulência: ${msg}`); }
  error(msg) { if (!this.err || Date.now() - this.err.at > 10 * MIN || this.err.msg !== msg) log('AVISO', `sombra quad turbulência: ${msg}`); this.err = { msg, at: Date.now() }; }

  start() {
    this.warming = this.warmAll().catch((e) => this.error(`aquecimento: ${e.message}`)).finally(() => { this.warming = null; });
    this.timer = setInterval(() => {
      const now = Date.now(), m = Math.floor(now / MIN) * MIN;
      if (this.busy || now - m < 3000 || m <= this.lastRun) return;
      this.lastRun = m; this.busy = true;
      this.updateAll(now).catch((e) => this.error(e.message)).finally(() => { this.busy = false; });
    }, 1000);
  }

  stop() { clearInterval(this.timer); }

  async klines(bsym, q) {
    return this.fetchJSON(`${BAPI}/klines?symbol=${bsym}&interval=1m&${q}`);
  }

  /** 31 dias de historico por ativo (sinais do historico ignorados) */
  async warmAll() {
    for (const sym of this.R.syms) {
      const bsym = sym + 'USDT';
      try {
        const now = Date.now(), end = Math.floor(now / MIN) * MIN;
        let from = end - (this.R.win + 1440) * MIN;
        const calc = new QTCalc(this.R);
        let last = -Infinity;
        for (let k = 0; k < 60 && from < end; k++) {
          const xs = await this.klines(bsym, `startTime=${from}&limit=1000`);
          for (const x of xs) {
            const b = kbar(x);
            if (b.t <= last || b.t + MIN > Date.now()) continue;
            last = b.t;
            if (!(b.v > 0 && b.h >= b.l)) continue;
            const prevT = calc.n ? calc.lastT : null;
            calc.push(b);
            // trades teoricos abertos antes de um reinicio continuam contando as barras do aquecimento
            if (this.st.theo.some((p) => p.sym === sym && b.t > p.t)) this.theoBar(sym, b, prevT);
          }
          if (xs.length < 1000) break;
          from = +xs.at(-1)[0] + MIN;
          await sleep(this.gapMs);
        }
        if (calc.n < this.R.minp) { this.error(`${sym}: só ${calc.n} barras no aquecimento`); continue; }
        this.calc.set(sym, calc); this.lastT.set(sym, last); this.bsym.set(sym, bsym);
      } catch (e) { this.error(`${sym}: aquecimento falhou (${e.message})`); }
      await sleep(this.gapMs);
    }
    this.log(`aquecido: ${this.calc.size}/${this.R.syms.length} ativos com 31 dias de candles de 1m da Binance`);
  }

  /** a cada minuto: busca os candles fechados novos de cada ativo aquecido */
  async updateAll(now) {
    let n = 0;
    for (const sym of this.calc.keys()) {
      try {
        const last = this.lastT.get(sym);
        const q = now - last > 4 * MIN ? `startTime=${last + MIN}&limit=1000` : 'limit=3';
        const xs = await this.klines(this.bsym.get(sym), q);
        for (const x of xs) { const b = kbar(x); if (b.t > this.lastT.get(sym) && b.t + MIN <= Date.now()) { this.onBar(sym, b, Date.now()); n++; } }
      } catch (e) { this.error(`${sym}: candles (${e.message})`); }
    }
    if (n) this.updatedAt = now;
  }

  /** uma barra fechada nova do ativo (tambem usada nos testes, com o relogio simulado) */
  onBar(sym, b, now) {
    this.lastT.set(sym, b.t);
    if (!(b.v > 0 && b.h >= b.l)) return null; // o backtest descarta barras sem volume
    const calc = this.calc.get(sym);
    const prevT = calc.n ? calc.lastT : null;
    const r = calc.push(b);
    this.theoBar(sym, b, prevT);
    if (r.sig) this.onSignal(sym, r, now);
    return r;
  }

  /** resultado teorico na Binance: sai no fechamento 60 barras depois (ou antes de um buraco > 30 min), como scripts/quadturb.trades */
  theoBar(sym, b, prevT) {
    let changed = false;
    for (const p of this.st.theo) {
      if (p.sym !== sym || p.exitT) continue;
      if (prevT !== null && b.t - prevT > this.R.gapMin * MIN) { p.exitT = prevT; p.exit = p.prevC; p.why = 'buraco'; }
      else if (--p.left <= 0) { p.exitT = b.t; p.exit = b.c; p.why = 'tempo'; }
      p.prevC = b.c;
      if (p.exitT) {
        p.bp = (p.exit / p.entry - 1) * 1e4;
        this.theoCsv.append({ t_in: iso(p.t), sym, entry_binance: p.entry, t_out: iso(p.exitT), exit_binance: p.exit, bp_binance: p.bp, motivo: p.why, trade_id: p.id ?? '' });
        this.st.done.push({ t: p.t, sym, bp: p.bp, id: p.id ?? null }); if (this.st.done.length > 3000) this.st.done.shift();
        changed = true;
      }
    }
    if (changed) { this.st.theo = this.st.theo.filter((p) => !p.exitT); this.save(); }
  }

  /** a Lighter negociou o ativo nos ultimos 5 min? (no crash de 10-11/10/2025 ela ficou 2,5h sem negocios); sem LiveBars (testes) = sim */
  fresh(sym, now) {
    const live = this.shadow.live;
    if (!live?.lastTs) return true;
    const ts = live.lastTs.get(sym);
    return Number.isFinite(ts) && now - ts <= 5 * MIN;
  }

  /** soma (em fracao) dos trades sombra do ativo fechados nas ultimas janelaH horas */
  recentLoss(sym, now) {
    const a = now - this.R.janelaH * H;
    return this.shadow.st.closed.filter((t) => t.strat === 'quad_turb' && t.sym === sym && t.closeTs > a && t.closeTs <= now && Number.isFinite(t.bp_mid))
      .reduce((s, t) => s + t.bp_mid / 1e4, 0);
  }

  onSignal(sym, r, now) {
    const R = this.R, sh = this.shadow;
    let why = null, p = null;
    const entryT = r.t + MIN; // fechamento da barra do sinal
    // posicao anterior do ativo que vence agora (saida na barra do novo sinal): fecha antes, como o backtest (pode entrar na barra da saida)
    for (const x of sh.st.pos.filter((q) => q.strat === 'quad_turb' && q.sym === sym && q.exitAt <= now)) sh.close(x, 'tempo');
    const open = sh.st.pos.filter((q) => q.strat === 'quad_turb').length;
    if (now - entryT > 3 * MIN) why = 'atrasado (barra antiga)';
    else if (sh.st.pos.some((x) => x.strat === 'quad_turb' && x.sym === sym)) why = 'já posicionado no ativo';
    else if ((this.st.pause[sym] ?? 0) > now) why = `disjuntor até ${iso(this.st.pause[sym]).slice(0, 16)}Z`;
    else if (this.recentLoss(sym, now) <= -R.perda) { this.st.pause[sym] = now + R.pausaH * H; why = `disjuntor: ${(this.recentLoss(sym, now) * 100).toFixed(1)}% em ${R.janelaH}h, pausa de ${R.pausaH}h`; }
    if (!why && !this.fresh(sym, now)) why = 'Lighter sem negócio há mais de 5 min (parada?)';
    if (!why) {
      p = sh.open('quad_turb', sym, 1, { event: `qt-${sym}-${iso(r.t).slice(0, 16)}`, exitAt: entryT + R.hold * MIN,
        info: `ATR ${r.atrBp.toFixed(1)}bp = ${r.rel.toFixed(2)}× · d60 ${r.d[3].toFixed(0)} · abertas ${open}` });
      if (!p) why = 'sem preço na Lighter';
    }
    if (p) this.st.theo.push({ t: r.t, sym, entry: r.c, left: R.hold, prevC: r.c, id: p.id }); // mesmo trade, com os fechamentos da Binance
    const row = { t: r.t, sym, c: r.c, d: r.d, atrBp: r.atrBp, rel: r.rel, abriu: !!p, why: why ?? 'aberto', open, id: p?.id ?? null };
    this.st.sigs.unshift(row); this.st.sigs.length = Math.min(this.st.sigs.length, 300);
    this.sigCsv.append({ t: iso(r.t), sym, close_binance: r.c, d9: r.d[0], d14: r.d[1], d40: r.d[2], d60: r.d[3], atr_bp: r.atrBp, atr_rel: r.rel,
      abriu: p ? 1 : 0, motivo: row.why, abertas: open, trade_id: p?.id ?? '' });
    this.log(`${sym} sinal ${iso(r.t).slice(11, 16)}Z (ATR ${r.rel.toFixed(2)}× · d60 ${r.d[3].toFixed(0)}): ${p ? `compra #${p.id}, sai ${iso(entryT + R.hold * MIN).slice(11, 16)}Z` : why}`);
    this.save();
    sh.save?.();
  }

  view() {
    const now = Date.now();
    const syms = this.R.syms.map((sym) => {
      const c = this.calc.get(sym), x = c?.last;
      return { sym, ready: !!c, t: x?.t ?? null, rel: x?.rel ?? null, d: x?.d ?? null, quad: x?.quad ?? false, pause: (this.st.pause[sym] ?? 0) > now ? this.st.pause[sym] : null,
        grupo: this.R.nucleo.includes(sym) ? 'núcleo' : this.R.baratos.includes(sym) ? 'barato' : 'outro' };
    });
    const done = this.st.done, mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
    return { rule: this.R, startedAt: this.st.startedAt, warming: !!this.warming, ready: this.calc.size, updatedAt: this.updatedAt,
      error: this.err, syms, sigs: this.st.sigs.slice(0, 60), theoOpen: this.st.theo.length,
      theo: { n: done.length, bp: mean(done.map((x) => x.bp)), nOpened: done.filter((x) => x.id !== null).length } };
  }
}
