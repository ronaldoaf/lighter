import path from 'node:path';
import { log, readJSON, writeJSON, ensureDir, CsvLog, sleep } from './util.js';

const MIN = 60_000, H = 3_600_000, DAY = 86_400_000;
const BAPI = 'https://fapi.binance.com/fapi/v1';

/** Regra congelada (FIM_DE_SEMANA.md secao 6; referencia scripts/study_wkd_strats.grid_window, vol de study_wkd_tradfi.prep). Nao mudar depois de iniciado. */
export const GF = {
  titulo: 'Grade de fim de semana', secao: 'FDS 6',
  regra: 'sexta 17:00 → domingo 17:00 ET; âncora = preço na abertura da janela; degrau g = 2 × desvio dos retornos de 1h dos 7 dias anteriores (Binance); ' +
    'ordens limite em âncora × (1 + k·g), k = −3..3: compra 1 unidade em cada nível abaixo e vende 1 em cada nível acima, preenchidas só se o preço passar 1 bp do nível; ' +
    'stop a mercado no 4º nível com a posição cheia (para até o fim); fecha o estoque domingo 17:00 ET; carteira BTC/ETH/SOL, XRP à parte; US$5k por ativo',
  c: 2, J: 3, eps: 1e-4, volH: 168, volMin: 120,
  syms: ['BTC', 'ETH', 'SOL', 'XRP'], carteira: ['BTC', 'ETH', 'SOL'],
  // custo por perna a mercado de US$5k na Lighter (scripts/spreads_por_ativo.csv, cost_5000), o mesmo do backtest (valor lido pelo pandas)
  custo: { BTC: 3.7601067843996325e-05, ETH: 2.3253004601649915e-05, SOL: 4.458886117389805e-05, XRP: 0.0001197050548395 },
  capUSD: 5000, // capital por ativo na Lighter (3 unidades); o stop e o fechamento varrem o livro com esse tamanho
  maxGapMin: 144, // mais de 5% da janela sem negocios ao vivo (coberta por candles de 1m) -> fim de semana parcial, fora da comparacao
  // backtest, carteira BTC/ETH/SOL, bp do capital por fim de semana: teo = stop no nivel (2024-26 e 2020-26); slip = stop 10 bp alem do nivel
  esperado: { teo: 18.4, teoTodo: 25.5, slip: 16.6, slipTodo: 23.2, dp: 104, xrpSlip: 2.3, preench: 5.6, stopFrac: 0.25 },
  criterio: { fds: 26, difMin: -5 },
};

// ---------------------------------------------------------------- relogio de Nova York
const etFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', weekday: 'short' });
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function etParts(t) {
  const p = Object.fromEntries(etFmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, hh: +p.hour % 24, mm: +p.minute, wd: WD[p.weekday] };
}

/** instante (ms) em que o relogio de Nova York marca y-mo-d hh:00 (dia fora do mes rola, como em Date.UTC) */
export function etClock(y, mo, d, hh) {
  const want = Date.UTC(y, mo - 1, d, hh);
  let t = want + 5 * H;
  for (let i = 0; i < 3; i++) {
    const p = etParts(t), got = Date.UTC(p.y, p.mo - 1, p.d, p.hh, p.mm);
    if (got === want) break;
    t += want - got;
  }
  return t;
}

/** janela sexta 17:00 -> domingo 17:00 ET que contem t; fora dela, a proxima (id = data da sexta em NY) */
export function weekendAt(t) {
  const p = etParts(t);
  const mk = (k) => {
    const f = new Date(Date.UTC(p.y, p.mo - 1, p.d - ((p.wd - 5 + 7) % 7) + 7 * k));
    const y = f.getUTCFullYear(), mo = f.getUTCMonth() + 1, d = f.getUTCDate();
    return { id: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`, T0: etClock(y, mo, d, 17), T1: etClock(y, mo, d + 2, 17) };
  };
  const w = mk(0);
  return t >= w.T1 ? mk(1) : w;
}

// ---------------------------------------------------------------- contas da referencia
/** desvio (ddof 1) dos retornos log de 1h nas 168 horas antes de T0; fechamento da hora = ultimo candle de 1m dela, hora sem candle repete
 *  o anterior; NaN com menos de 120 retornos (= prep de study_wkd_tradfi: rolling(168, min_periods=120).std().shift(1)) */
export function hourVol(bars, T0, R = GF) {
  const H0 = Math.floor(T0 / H), first = H0 - R.volH - 1, last = new Map();
  for (const b of bars) { const k = Math.floor(b.t / H); if (k >= first && k < H0) last.set(k, b.c); }
  const r = [];
  let prev = NaN;
  for (let k = first; k < H0; k++) {
    const c = last.has(k) ? last.get(k) : prev;
    if (k > first) { const x = Math.log(c) - Math.log(prev); if (Number.isFinite(x)) r.push(x); }
    prev = c;
  }
  if (r.length < R.volMin) return NaN;
  const m = r.reduce((s, x) => s + x, 0) / r.length;
  return Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / (r.length - 1));
}

/**
 * Um candle de 1m no caminho do backtest (alta o->l->h->c, baixa o->h->l->c), mesmas contas e na mesma ordem de grid_window.
 * s = {a, g, lvl, pos, cash, nf, halted}. Preenchimentos limite entram no caixa; o stop zera a posicao e para a grade, mas o caixa da
 * perna a mercado fica com quem chama (evento {side: 'stop', px, qty}: px = nivel, ou a abertura se ela ja passou dele; qty > 0 = compra).
 */
export function gridBar(s, b, R = GF) {
  const J = R.J, eps = R.eps, ev = [];
  if (s.halted) return ev;
  const upFirst = b.c < b.o;
  for (let leg = 0; leg < 2; leg++) {
    if ((leg === 0) === upFirst) {
      while (s.lvl + 1 <= J) {
        const L = s.a * (1 + (s.lvl + 1) * s.g);
        if (b.h >= L * (1 + eps)) { s.cash += L; s.pos -= 1; s.lvl += 1; s.nf += 1; ev.push({ side: 'sell', k: s.lvl, px: L }); } else break;
      }
      if (s.pos <= -J) {
        const Ls = s.a * (1 + (J + 1) * s.g);
        if (b.h >= Ls) { const q = -s.pos; s.pos = 0; s.halted = true; ev.push({ side: 'stop', k: J + 1, px: b.o < Ls ? Ls : b.o, qty: q }); return ev; }
      }
    } else {
      while (s.lvl - 1 >= -J) {
        const L = s.a * (1 + (s.lvl - 1) * s.g);
        if (b.l <= L * (1 - eps)) { s.cash -= L; s.pos += 1; s.lvl -= 1; s.nf += 1; ev.push({ side: 'buy', k: s.lvl, px: L }); } else break;
      }
      if (s.pos >= J) {
        const Ls = s.a * (1 - (J + 1) * s.g);
        if (b.l <= Ls) { const q = s.pos; s.pos = 0; s.halted = true; ev.push({ side: 'stop', k: -(J + 1), px: b.o > Ls ? Ls : b.o, qty: -q }); return ev; }
      }
    }
  }
  return ev;
}

/** Um negocio da Lighter a preco p (as mesmas regras de gridBar num ponto do caminho). prev = negocio anterior: se ele ja estava alem do
 *  nivel do stop (buraco), o preco de referencia do stop e p, como a abertura do candle no backtest. */
export function gridTrade(s, p, prev, R = GF) {
  const J = R.J, eps = R.eps, ev = [];
  if (s.halted) return ev;
  while (s.lvl + 1 <= J) {
    const L = s.a * (1 + (s.lvl + 1) * s.g);
    if (p >= L * (1 + eps)) { s.cash += L; s.pos -= 1; s.lvl += 1; s.nf += 1; ev.push({ side: 'sell', k: s.lvl, px: L }); } else break;
  }
  while (s.lvl - 1 >= -J) {
    const L = s.a * (1 + (s.lvl - 1) * s.g);
    if (p <= L * (1 - eps)) { s.cash -= L; s.pos += 1; s.lvl -= 1; s.nf += 1; ev.push({ side: 'buy', k: s.lvl, px: L }); } else break;
  }
  if (s.pos <= -J) {
    const Ls = s.a * (1 + (J + 1) * s.g);
    if (p >= Ls) { const q = -s.pos; s.pos = 0; s.halted = true; ev.push({ side: 'stop', k: J + 1, px: prev != null && prev >= Ls ? p : Ls, qty: q }); }
  } else if (s.pos >= J) {
    const Ls = s.a * (1 - (J + 1) * s.g);
    if (p <= Ls) { const q = s.pos; s.pos = 0; s.halted = true; ev.push({ side: 'stop', k: -(J + 1), px: prev != null && prev <= Ls ? p : Ls, qty: -q }); }
  }
  return ev;
}

/** resultado da trilha da Lighter em bp do capital: real (pernas a mercado pelo livro), mid (no meio do livro) e nivel (como o backtest:
 *  stop no nivel, fechamento no ultimo negocio, com o custo do backtest); sem livro, real e mid caem para o preco de nivel */
export function lighterResult(L, R = GF) {
  const cost = R.custo[L.sym] ?? 0, k = 1e4 / (R.J * L.a);
  let real = L.cash, mid = L.cash, lvl = L.cash, slip = null, endCost = null;
  for (const g of L.legs) {
    const sg = Math.sign(g.qty), lv = g.lvl * (1 + sg * cost);
    lvl -= g.qty * lv;
    mid -= g.qty * (Number.isFinite(g.mid) ? g.mid : g.lvl);
    real -= g.qty * (Number.isFinite(g.vwap) ? g.vwap : lv);
    if (g.why === 'stop' && Number.isFinite(g.vwap)) slip = sg * (g.vwap / g.lvl - 1) * 1e4;
    if (g.why === 'fim' && Number.isFinite(g.vwap) && Number.isFinite(g.mid)) endCost = sg * (g.vwap / g.mid - 1) * 1e4;
  }
  return { real: real * k, mid: mid * k, lvl: lvl * k, fund: L.fund * k, slip, endCost };
}

// ---------------------------------------------------------------- modo sombra
async function getJSON(url, ms = 15000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
const kbar = (k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] });
const iso = (t) => new Date(t).toISOString();
const fin = Number.isFinite;
const mean = (xs) => { const a = xs.filter(fin); return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null; };
const sd = (xs) => { const a = xs.filter(fin); if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };

/**
 * Grade de fim de semana no modo sombra (sem capital), em duas trilhas com a mesma regra e o mesmo degrau:
 *   binance: o backtest ao vivo (candles de 1m da Binance USDT-M, caminho OHLC, custo do backtest) - o "teorico";
 *   lighter: ancora no mid da Lighter as 17:00 ET; ordens limite preenchidas pelos negocios da Lighter (passar 1 bp do nivel); stop e
 *            fechamento varrendo o livro ao vivo com US$5k por ativo; funding real. Negocios perdidos (reinicio, queda do canal) sao
 *            cobertos pelos candles de 1m da Lighter, com os minutos contados.
 * O que se mede e a execucao (preenchimento nos pavios da Lighter, slippage do stop) contra o teorico, nao o edge.
 * Estado em data/shadow/wkd_grid/state.json; windows.csv (ativo x fim de semana) e events.csv (preenchimentos, stops, fechamentos).
 */
export class WeekendGrid {
  constructor({ dataDir, shadow, rest = null, R = GF, fetchJSON = getJSON, gapMs = 250 }) {
    Object.assign(this, { shadow, rest, R, fetchJSON, gapMs });
    this.dir = ensureDir(path.join(dataDir, 'shadow', 'wkd_grid'));
    this.file = path.join(this.dir, 'state.json');
    this.st = readJSON(this.file, null) ?? { startedAt: Date.now(), cur: null, done: [] };
    this.winCsv = new CsvLog(path.join(this.dir, 'windows.csv'), ['janela', 'ativo', 'inicio', 'fim', 'ancora_lighter', 'fonte_ancora', 'ancora_binance',
      'vol_1h', 'degrau_bp', 'preench_lighter', 'preench_binance', 'stop_lighter', 'stop_binance', 'bp_real', 'bp_mid', 'bp_nivel', 'bp_teorico',
      'funding_bp', 'slip_stop_bp', 'custo_fim_bp', 'buraco_min', 'parcial']);
    this.evCsv = new CsvLog(path.join(this.dir, 'events.csv'), ['janela', 'trilha', 'ativo', 't', 'evento', 'nivel', 'preco_nivel', 'qtd',
      'preco_negocio', 'usd_negocio', 'mid', 'vwap', 'livro_completo', 'fonte']);
    this.symSet = new Set(this.R.syms);
    this.buf = new Map(); this.bufSince = new Map(); this.subSeen = new Map();
    this.busy = new Set(); this.lastBin = 0; this.err = null;
    // reinicio no meio da janela: os negocios perdidos com o app parado sao cobertos por candles de 1m da Lighter
    const w = this.st.cur, now = Date.now();
    if (w) for (const L of Object.values(w.L)) if (!L.done) { L.mode = 'buffer'; this.buf.set(L.sym, []); this.bufSince.set(L.sym, now); }
  }

  save() { writeJSON(this.file, this.st); }
  log(msg) { log('SOMBRA', `grade fds: ${msg}`); }
  error(msg) { if (!this.err || Date.now() - this.err.at > 10 * MIN || this.err.msg !== msg) log('AVISO', `sombra grade fds: ${msg}`); this.err = { msg, at: Date.now() }; }

  start() {
    this.timer = setInterval(() => { this.tick(Date.now()).catch((e) => this.error(e.message)); }, 1000);
  }
  stop() { clearInterval(this.timer); }

  mid(sym) {
    const b = this.shadow?.recorder?.books?.get(sym), t = b?.ready ? b.top() : null;
    return t ? t.mid : NaN;
  }

  /** candles fechados de 1m da Lighter em [from, to) */
  async candles(sym, from, to) {
    const m = this.shadow?.markets?.().find((x) => x.symbol === sym);
    if (!this.rest || !m) throw new Error(`sem REST da Lighter para ${sym}`);
    return this.rest.candles(m.market_id, from, to, '1m');
  }

  // ---------------------------------------------------------------- relogio (1 s)
  /** abre/fecha janelas e dispara o trabalho assincrono (vol, candles da Binance, recuperacao da Lighter); devolve a promessa de tudo */
  tick(now = Date.now()) {
    const jobs = [], R = this.R;
    const run = (key, fn) => {
      if (this.busy.has(key)) return;
      this.busy.add(key);
      jobs.push(fn().catch((e) => this.error(`${key}: ${e.message}`)).finally(() => this.busy.delete(key)));
    };
    const wk = weekendAt(now);
    let w = this.st.cur;
    if (now >= wk.T0 && now < wk.T1 && w?.id !== wk.id) {
      if (w) this.finish(w, now, 'substituída por uma janela nova (app parado)');
      w = this.open(wk, now);
    }
    if (!w) return Promise.all(jobs);
    const pend = R.syms.filter((s) => w.g[s] == null);
    if (pend.length && now - (w.volTry ?? 0) >= MIN) { w.volTry = now; run('vol', () => this.loadVol(w, pend)); }
    const m = Math.floor(now / MIN) * MIN;
    if (now - m >= 3000 && m > this.lastBin && R.syms.some((s) => w.g[s] != null && !w.B[s].done)) { this.lastBin = m; run('bin', () => this.updateBin(w, now)); }
    for (const s of R.syms) {
      const L = w.L[s];
      if (L.done || w.g[s] == null || this.busy.has(`L:${s}`)) continue;
      if (L.mode === 'buffer') { if (now >= (L.nextTry ?? 0)) run(`L:${s}`, () => this.flush(w, L, now)); }
      else if (now >= w.T1) this.closeLighter(w, L, now);
    }
    if (now >= w.T1 + 6 * H) { // sem dados muito depois do fim: desiste do que faltar
      for (const s of R.syms) {
        if (!w.B[s].done) { w.B[s].done = true; w.B[s].why = 'sem candles da Binance'; }
        if (!w.L[s].done) { w.L[s].done = true; w.L[s].why = 'sem dados da Lighter'; }
      }
    }
    if (R.syms.every((s) => w.B[s].done && w.L[s].done)) this.finish(w, now);
    return Promise.all(jobs);
  }

  open(wk, now) {
    const late = now - wk.T0 > 30_000, w = { id: wk.id, T0: wk.T0, T1: wk.T1, openedAt: now, late, vol: {}, g: {}, B: {}, L: {}, ev: [] };
    for (const s of this.R.syms) {
      w.B[s] = { sym: s, a: null, t0: null, g: null, lvl: 0, pos: 0, cash: 0, nf: 0, halted: false, lastT: wk.T0 - MIN, lastC: null, stop: null, done: false, pnl: null };
      const mid = late ? NaN : this.mid(s);
      w.L[s] = { sym: s, a: fin(mid) ? mid : null, src: fin(mid) ? 'mid' : null, g: null, unit: null, lvl: 0, pos: 0, cash: 0, nf: 0, halted: false,
        mode: 'buffer', lastTs: wk.T0 - 1, lastPx: null, gapMin: 0, legs: [], fund: 0, fundTs: wk.T0, done: false, res: null };
      this.buf.set(s, []); this.bufSince.set(s, late ? now : wk.T0);
    }
    this.st.cur = w; this.save();
    this.log(`janela ${w.id} aberta (${iso(w.T0).slice(0, 16)}Z → ${iso(w.T1).slice(0, 16)}Z)${late ? ', atrasada: âncora e negócios até agora pelos candles de 1m da Lighter' : ''}; ` +
      `âncoras ${this.R.syms.map((s) => `${s} ${w.L[s].a ?? '–'}`).join(' · ')}`);
    return w;
  }

  /** degrau de cada ativo: 2 x vol de 1h das 168 horas antes da abertura (candles de 1m da Binance) */
  async loadVol(w, syms) {
    const R = this.R, H0 = Math.floor(w.T0 / H);
    for (const s of syms) {
      const bars = [];
      let from = (H0 - R.volH - 2) * H;
      for (let k = 0; k < 12 && from < w.T0; k++) {
        const xs = await this.fetchJSON(`${BAPI}/klines?symbol=${s}USDT&interval=1m&startTime=${from}&endTime=${w.T0 - 1}&limit=1500`);
        for (const x of xs) { const b = kbar(x); if (b.t >= from && b.t < w.T0) bars.push(b); }
        if (xs.length < 1500) break;
        from = +xs.at(-1)[0] + MIN;
        await sleep(this.gapMs);
      }
      const v = hourVol(bars, w.T0, R);
      if (!fin(v)) { this.error(`${s}: vol de 1h indisponível (${bars.length} candles da Binance)`); continue; }
      w.vol[s] = v; w.g[s] = R.c * v; w.B[s].g = w.g[s]; w.L[s].g = w.g[s];
      this.log(`${s}: degrau ${(w.g[s] * 1e4).toFixed(0)} bp (vol de 1h ${(v * 1e4).toFixed(1)} bp), stop a ${((R.J + 1) * w.g[s] * 100).toFixed(1)}%`);
      await sleep(this.gapMs);
    }
    this.save();
  }

  // ---------------------------------------------------------------- trilha teorica (Binance)
  async updateBin(w, now) {
    for (const s of this.R.syms) {
      const B = w.B[s];
      if (B.done || B.g == null) continue;
      for (let k = 0; k < 4 && !B.done; k++) {
        const lim = now - B.lastT > 90 * MIN ? 1500 : 99; // lote grande so para recuperar atraso (peso 10 x 1 na Binance)
        const xs = await this.fetchJSON(`${BAPI}/klines?symbol=${s}USDT&interval=1m&startTime=${B.lastT + MIN}&limit=${lim}`);
        for (const x of xs) {
          const b = kbar(x);
          if (b.t <= B.lastT || b.t + MIN > now) continue;
          if (b.t >= w.T1) { this.binEnd(w, B); break; }
          this.binBar(w, B, b);
          if (b.t + MIN >= w.T1) { this.binEnd(w, B); break; }
        }
        if (xs.length < lim) break;
        await sleep(this.gapMs);
      }
      if (!B.done && now >= w.T1 + 10 * MIN && B.a != null) this.binEnd(w, B); // a Binance nao devolveu o ultimo candle
    }
    this.save();
  }

  binBar(w, B, b) {
    if (B.a == null) { B.a = b.o; B.t0 = b.t; }
    const cost = this.R.custo[B.sym];
    for (const e of gridBar(B, b, this.R)) {
      if (e.side === 'stop') {
        if (e.qty > 0) B.cash -= e.qty * e.px * (1 + cost); else B.cash += (-e.qty) * e.px * (1 - cost);
        B.stop = { t: b.t, k: e.k, px: e.px, qty: e.qty };
      }
      this.event(w, 'binance', B.sym, b.t, e, { fonte: 'candle' });
    }
    B.lastT = b.t; B.lastC = b.c;
  }

  binEnd(w, B) {
    if (B.done) return;
    B.done = true;
    if (B.a == null) { B.why = 'sem candles'; return; }
    if (B.pos !== 0) {
      const px = B.lastC, cost = this.R.custo[B.sym];
      B.cash += B.pos * px - Math.abs(B.pos) * px * cost;
      this.event(w, 'binance', B.sym, B.lastT, { side: 'fim', k: B.lvl, px, qty: -B.pos }, { fonte: 'candle' });
      B.endPos = B.pos; B.pos = 0;
    }
    B.pnl = B.cash / (this.R.J * B.a);
    this.log(`${B.sym} teórico (Binance): ${(B.pnl * 1e4).toFixed(1)} bp, ${B.nf} preenchimentos${B.stop ? `, stop no nível ${B.stop.k}` : ''}`);
  }

  // ---------------------------------------------------------------- trilha da Lighter
  onTrade(sym, x) {
    if (!this.symSet.has(sym)) return;
    const sub = this.shadow?.live?.subAt?.get(sym) ?? null;
    const resub = this.subSeen.has(sym) && this.subSeen.get(sym) !== sub; // canal de negocios reinscrito com o app rodando
    this.subSeen.set(sym, sub);
    const w = this.st.cur, L = w?.L?.[sym];
    if (!L || L.done) return;
    const t = { ts: +x.timestamp, price: +x.price, usd: +x.usd_amount };
    if (resub && L.mode === 'live') {
      L.mode = 'buffer'; this.buf.set(sym, []); this.bufSince.set(sym, t.ts);
      this.log(`${sym}: canal de negócios reinscrito; o buraco desde ${iso(L.lastTs).slice(11, 19)}Z vai pelos candles de 1m`);
    }
    if (L.mode === 'buffer') {
      if (t.ts < w.T0 || t.ts >= w.T1) return;
      const b = this.buf.get(sym);
      b.push(t);
      if (b.length > 200_000) { b.splice(0, 100_000); this.bufSince.set(sym, b[0].ts); } // o que cair fica para os candles
      return;
    }
    this.lighterTrade(w, L, t);
  }

  /** sai do modo buffer: candles de 1m para os minutos sem negocios ao vivo, depois os negocios guardados */
  async flush(w, L, now) {
    const s = L.sym, R = this.R;
    const buf0 = this.buf.get(s) ?? [], since = this.bufSince.get(s) ?? -Infinity;
    const gap = since > L.lastTs + 1; // buraco = do ultimo negocio processado ate o inicio do buffer
    // depois de um reinicio o canal de negocios demora a ser inscrito: o buraco vai ate a inscricao (ou o primeiro negocio guardado)
    const subAt = this.shadow?.live?.subAt, sub = subAt ? subAt.get(s) : since;
    if (gap && !buf0.length && sub == null) return;
    const from = Math.floor(L.lastTs / MIN) * MIN + MIN;
    const head = buf0.length ? buf0[0].ts : Math.max(sub, since);
    const to = gap ? Math.min(Math.floor(head / MIN) * MIN, w.T1) : from;
    let cs = [];
    if (to > from) {
      try { cs = (await this.candles(s, from, to)).filter((b) => b.t >= from && b.t < to).sort((a, b) => a.t - b.t); }
      catch (e) { L.nextTry = now + 30_000; throw e; }
    }
    if (L.a == null) { // sem livro na abertura (app parado ou iniciando): ancora = abertura do primeiro candle da janela
      const b0 = cs[0], x0 = (this.buf.get(s) ?? [])[0];
      if (b0) { L.a = b0.o; L.src = b0.t === w.T0 ? 'candle' : 'candle atrasado'; }
      else if (x0) { L.a = x0.price; L.src = 'negócio'; }
      else { L.nextTry = now + 30_000; return; }
    }
    if (L.unit == null) {
      L.g = w.g[s]; L.unit = R.capUSD / (R.J * L.a);
      this.log(`${s} na Lighter: âncora ${L.a} (${L.src}), níveis ${[-3, -2, -1, 1, 2, 3].map((k) => +(L.a * (1 + k * L.g)).toPrecision(6)).join(' / ')}, stops ${+(L.a * (1 - 4 * L.g)).toPrecision(6)} e ${+(L.a * (1 + 4 * L.g)).toPrecision(6)}`);
    }
    for (const b of cs) this.lighterBar(w, L, b);
    if (to > from) {
      L.gapMin += (to - from) / MIN; L.coverTo = to; L.lastTs = Math.max(L.lastTs, to - 1);
      if (to - from > MIN) this.log(`${s}: ${(to - from) / MIN} min cobertos por ${cs.length} candles de 1m da Lighter`);
    }
    L.mode = 'live';
    const buf = this.buf.get(s) ?? [];
    this.buf.set(s, []); this.bufSince.delete(s);
    for (const t of buf) this.lighterTrade(w, L, t);
    this.save();
  }

  lighterBar(w, L, b) {
    if (b.t < (L.coverTo ?? -Infinity) || b.t >= w.T1) return;
    L.lastTs = Math.max(L.lastTs, b.t + MIN - 1); L.lastPx = b.c;
    for (const e of gridBar(L, b, this.R)) {
      if (e.side === 'stop') this.leg(w, L, 'stop', e.qty, e.px, b.t, false, null, e.k);
      else this.event(w, 'lighter', L.sym, b.t, e, { fonte: 'candle' });
    }
  }

  /** negocio ao vivo; negocios no mesmo milissegundo (uma ordem varrendo varios niveis) contam todos; os de minutos ja cobertos por candle, nao */
  lighterTrade(w, L, t) {
    if (t.ts < L.lastTs || t.ts < (L.coverTo ?? -Infinity) || t.ts >= w.T1 || !(t.price > 0)) return;
    const prev = L.lastPx;
    L.lastTs = t.ts; L.lastPx = t.price;
    if (L.halted) return;
    const ev = gridTrade(L, t.price, prev, this.R);
    for (const e of ev) {
      if (e.side === 'stop') this.leg(w, L, 'stop', e.qty, e.px, t.ts, true, t, e.k);
      else { this.event(w, 'lighter', L.sym, t.ts, e, { preco_negocio: t.price, usd_negocio: t.usd, fonte: 'negócio' }); this.shadow?.recorder?.markHot?.(L.sym, 15 * MIN); }
    }
    if (ev.length) this.save();
  }

  /** perna a mercado (stop ou fechamento): varre o livro ao vivo com a posicao inteira (unidades x US$5k/3) */
  leg(w, L, why, qty, lvlPx, t, useBook, tr = null, k = null) {
    const b = useBook ? this.shadow?.recorder?.books?.get(L.sym) : null, top = b?.ready ? b.top() : null;
    let vwap = NaN, complete = false;
    if (top) { const s = b.sweepQty(qty > 0 ? 'buy' : 'sell', Math.abs(qty) * L.unit); complete = s.complete; vwap = s.complete ? s.avg : NaN; }
    const g = { why, t, qty, lvl: lvlPx, mid: top ? top.mid : NaN, vwap, complete, src: top ? 'livro' : useBook ? 'sem livro' : 'candle', at: Date.now() };
    L.legs.push(g);
    if (top) {
      try { this.shadow.recorder.snapshot?.(L.sym, 'grade_fds', Date.now(), { why, qty, lvl: lvlPx }); this.shadow.recorder.markHot?.(L.sym, 30 * MIN); } catch { /* so registro */ }
    }
    this.event(w, 'lighter', L.sym, t, { side: why, k: k ?? L.lvl, px: lvlPx, qty }, { preco_negocio: tr?.price, usd_negocio: tr?.usd, mid: g.mid, vwap,
      livro_completo: top ? (complete ? 1 : 0) : '', fonte: g.src });
    const slip = fin(vwap) ? Math.sign(qty) * (vwap / lvlPx - 1) * 1e4 : NaN;
    this.log(`${L.sym} Lighter: ${why === 'stop' ? 'STOP' : 'fechamento'} ${qty > 0 ? 'compra' : 'vende'} ${Math.abs(qty)} un. — nível ${lvlPx.toPrecision(6)}, ` +
      `mid ${fin(g.mid) ? g.mid.toPrecision(6) : '–'}, executado ${fin(vwap) ? vwap.toPrecision(6) : '–'} (${fin(slip) ? slip.toFixed(1) + ' bp além do nível' : g.src})`);
  }

  closeLighter(w, L, now) {
    if (L.done) return;
    if (L.a != null && L.unit != null && L.pos !== 0) {
      const live = now - w.T1 <= 2 * MIN; // app parado no fim: fecha no ultimo preco conhecido, sem livro
      L.endPos = L.pos;
      const q = -L.pos;
      L.pos = 0;
      this.leg(w, L, 'fim', q, L.lastPx ?? L.a, w.T1, live, null, L.lvl);
    }
    L.done = true;
    if (L.a != null && L.unit != null) L.res = lighterResult(L, this.R);
    else L.why = 'sem âncora';
    this.save();
  }

  onStats(sym, ms) {
    const w = this.st.cur, L = w?.L?.[sym];
    if (!L || L.done || L.unit == null || !ms?.funding_timestamp) return;
    const ft = +ms.funding_timestamp;
    if (!(ft > L.fundTs) || ft > w.T1) return;
    const rate = +ms.funding_rate, px = +ms.mark_price || L.lastPx || L.a; // %/h, positivo = comprados pagam
    if (fin(rate)) L.fund += -L.pos * px * rate / 100;
    L.fundTs = ft;
  }

  event(w, trilha, sym, t, e, x = {}) {
    const row = { janela: w.id, trilha, ativo: sym, t: iso(t), evento: e.side, nivel: e.k, preco_nivel: e.px, qtd: e.qty ?? (e.side === 'buy' ? 1 : -1), ...x };
    this.evCsv.append(row);
    w.ev.push({ trilha, sym, t, side: e.side, k: e.k, px: e.px, qty: row.qtd, vwap: x.vwap ?? null, mid: x.mid ?? null, fonte: x.fonte ?? null });
    if (w.ev.length > 120) w.ev.splice(0, w.ev.length - 120);
  }

  // ---------------------------------------------------------------- fechamento da janela
  finish(w, now, why = null) {
    const R = this.R, assets = {};
    for (const s of R.syms) {
      const B = w.B[s], L = w.L[s], r = L.res, stopL = L.legs.find((g) => g.why === 'stop');
      const a = { sym: s, aL: L.a, src: L.src, aB: B.a, vol: w.vol[s] ?? null, g: w.g[s] ?? null, nfL: L.nf, nfB: B.nf, stopL: stopL ? Math.sign(stopL.qty) * (R.J + 1) : 0,
        stopB: B.stop ? B.stop.k : 0, real: r?.real ?? null, mid: r?.mid ?? null, lvl: r?.lvl ?? null, theo: B.done && B.pnl != null ? B.pnl * 1e4 : null,
        fund: r?.fund ?? null, slip: r?.slip ?? null, endCost: r?.endCost ?? null, gapMin: L.gapMin, why: L.why ?? B.why ?? null };
      a.parcial = !!why || L.gapMin > R.maxGapMin || a.real == null || a.theo == null;
      assets[s] = a;
      this.winCsv.append({ janela: w.id, ativo: s, inicio: iso(w.T0), fim: iso(w.T1), ancora_lighter: a.aL, fonte_ancora: a.src ?? '', ancora_binance: a.aB, vol_1h: a.vol,
        degrau_bp: a.g != null ? a.g * 1e4 : null, preench_lighter: a.nfL, preench_binance: a.nfB, stop_lighter: a.stopL, stop_binance: a.stopB, bp_real: a.real, bp_mid: a.mid,
        bp_nivel: a.lvl, bp_teorico: a.theo, funding_bp: a.fund, slip_stop_bp: a.slip, custo_fim_bp: a.endCost, buraco_min: a.gapMin, parcial: a.parcial ? 1 : 0 });
    }
    const grp = (syms) => {
      const xs = syms.map((s) => assets[s]), k = (f) => mean(xs.map((a) => a[f]));
      return { real: k('real'), mid: k('mid'), lvl: k('lvl'), theo: k('theo'), fund: k('fund'), diff: xs.every((a) => a.real != null && a.theo != null) ? mean(xs.map((a) => a.real - a.theo)) : null,
        parcial: xs.some((a) => a.parcial) };
    };
    const sum = { id: w.id, T0: w.T0, T1: w.T1, late: w.late, why, assets, cart: grp(R.carteira), xrp: grp(R.syms.filter((s) => !R.carteira.includes(s))), at: now };
    this.st.done.push(sum);
    if (this.st.done.length > 300) this.st.done.shift();
    this.st.cur = null;
    this.buf.clear(); this.bufSince.clear();
    this.save();
    const c = sum.cart, f = (x) => (x == null ? '–' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}`);
    this.log(`janela ${w.id} fechada${why ? ` (${why})` : ''}: BTC/ETH/SOL real ${f(c.real)} bp · teórico Binance ${f(c.theo)} bp · diferença ${f(c.diff)} bp${c.parcial ? ' (parcial)' : ''}`);
  }

  // ---------------------------------------------------------------- painel
  view(now = Date.now()) {
    const R = this.R, w = this.st.cur;
    const cur = w ? { id: w.id, T0: w.T0, T1: w.T1, late: w.late, ev: w.ev.slice(-40).reverse(), assets: R.syms.map((s) => {
      const B = w.B[s], L = w.L[s], m = this.mid(s), g = w.g[s] ?? null;
      let bpL = null;
      if (L.a != null && L.unit != null) {
        let cash = L.cash;
        for (const x of L.legs) cash -= x.qty * (fin(x.mid) ? x.mid : x.lvl);
        const px = fin(m) ? m : L.lastPx;
        bpL = (cash + L.pos * (px ?? 0)) * 1e4 / (R.J * L.a);
      }
      return { sym: s, g, carteira: R.carteira.includes(s),
        levels: L.a != null && g != null ? [-4, -3, -2, -1, 0, 1, 2, 3, 4].map((k) => L.a * (1 + k * g)) : null, midNow: fin(m) ? m : null,
        L: { a: L.a, src: L.src, lvl: L.lvl, pos: L.pos, nf: L.nf, halted: L.halted, mode: L.mode, gapMin: L.gapMin, done: L.done, res: L.res, bp: bpL, fund: L.unit ? L.fund * 1e4 / (R.J * L.a) : null },
        B: { a: B.a, lvl: B.lvl, pos: B.pos, nf: B.nf, halted: B.halted, done: B.done, bp: B.a != null ? (B.done ? B.pnl * 1e4 : (B.cash + B.pos * B.lastC) * 1e4 / (R.J * B.a)) : null } };
    }) } : null;
    const done = this.st.done, ok = done.filter((d) => !d.cart.parcial);
    const col = (f, g = 'cart') => ok.map((d) => d[g][f]);
    const n = ok.length, mr = mean(col('real')), diffs = col('diff'), sdD = sd(diffs), sdR = sd(col('real'));
    const sumReal = col('real').filter(fin).reduce((a, b) => a + b, 0);
    const E = R.esperado;
    const stats = { n, nAll: done.length, real: mr, realT: sdR ? mr / (sdR / Math.sqrt(col('real').filter(fin).length)) : null,
      mid: mean(col('mid')), lvl: mean(col('lvl')), theo: mean(col('theo')), fund: mean(col('fund')), diff: mean(diffs),
      diffT: sdD ? mean(diffs) / (sdD / Math.sqrt(diffs.filter(fin).length)) : null, sumReal, sumTheo: col('theo').filter(fin).reduce((a, b) => a + b, 0),
      sdReal: sdR, xrpReal: mean(ok.map((d) => d.xrp.real)), xrpTheo: mean(ok.map((d) => d.xrp.theo)),
      nfL: mean(ok.flatMap((d) => R.carteira.map((s) => d.assets[s].nfL))), nfB: mean(ok.flatMap((d) => R.carteira.map((s) => d.assets[s].nfB))),
      stopsL: ok.reduce((a, d) => a + R.carteira.filter((s) => d.assets[s].stopL).length, 0), stopsB: ok.reduce((a, d) => a + R.carteira.filter((s) => d.assets[s].stopB).length, 0),
      slip: mean(ok.flatMap((d) => R.carteira.map((s) => d.assets[s].slip))), endCost: mean(ok.flatMap((d) => R.carteira.map((s) => d.assets[s].endCost))),
      floor: n ? n * E.slip - Math.sqrt(n) * E.dp : null };
    stats.crit = { n: n >= R.criterio.fds, diff: stats.diff != null && stats.diff >= R.criterio.difMin, soma: n ? sumReal >= stats.floor : null };
    return { rule: R, startedAt: this.st.startedAt, next: weekendAt(now), cur, done: done.slice(-60).reverse(), stats, error: this.err };
  }
}
