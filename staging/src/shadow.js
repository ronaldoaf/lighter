import path from 'node:path';
import https from 'node:https';
import { BAR, log, readJSON, writeJSON, ensureDir, CsvLog } from './util.js';

const MIN = 60_000, H = 3_600_000, DAY = 86_400_000;
const SIZES = [1000, 5000]; // notional de referencia para o preco executavel (varrendo o livro gravado)

// NYSE (secao 11): feriados; perps de acoes/ETF fora dos EUA ficam de fora do fim de semana
const HOLIDAYS = new Set(['2025-11-27', '2025-12-25', '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25', '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26',
  '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24']);
const NON_US = new Set(['SAMSUNG', 'SAMSUNGUSD', 'SKHY', 'SKHYNIX', 'SKHYNIXUSD', 'HYUNDAI', 'HYUNDAIUSD', 'HANMI', 'TENCENT',
  'XIAOMI', 'CXMT', 'MINIMAX', 'ZHIPU', 'KRCOMP', 'WEN']);

/**
 * Regras congeladas de cada candidato (fixadas antes de rodar; nao mudar depois de iniciado).
 * Nenhum usa capital: cada trade vale 1 unidade de notional e o resultado sai em bp.
 */
export const RULES = {
  fade_tbf: { titulo: 'Fade × compra agressiva (B3)', secao: 31,
    regra: 'marca cada sinal do fade e do C2 com a fração do volume comprada a mercado na barra (Lighter e Binance); hipótese: tbf ≥ 0,58 rende menos', corte: 0.58 },
  mom_esticado: { titulo: 'Momentum sem esticados', secao: 25,
    regra: 'momentum do paper (14d ret/vol, 3×3, holding 7d), trocando pelo próximo do ranking a perna com retorno de 3d a favor ≥ 1,5·σ·√3; comparado com a base no mesmo motor', L: 3, g: 1.5 },
  capitulacao: { titulo: 'Long após capitulação (F1)', secao: '24.6',
    regra: 'na hora cheia, ≥ 35% dos cripto líquidos com score curto ≤ −80 (eventos ≥ 3 dias apart): compra 1h depois os 5 de menor score, sem stop, sai 24h depois', frac: 0.35, score: -80, n: 5, delayH: 1, holdH: 24, gapD: 3, liq: 5e5 },
  overnight: { titulo: 'Overnight long (E1)', secao: '16.3',
    regra: 'compra às 16:00 ET de cada pregão e vende às 9:00 ET do pregão seguinte (atravessa o fim de semana)', syms: ['US500', 'US100', 'SPY', 'QQQ', 'XAU', 'XAG'] },
  rsi2: { titulo: 'RSI(2) Connors (E2)', secao: '16.1',
    regra: 'fechamento diário às 16:00 ET; compra se RSI(2) < 10, vende quando RSI(2) > 70; só long, sem filtro de média', syms: ['US500', 'US100', 'SPY', 'QQQ', 'IWM'], entry: 10, exit: 70 },
  fds_acoes: { titulo: 'Fade de fim de semana em ações (E3)', secao: 11,
    regra: 'x = retorno de sexta 20:00 a domingo 20:00 ET; abre contra x no domingo 20:00 e sai na segunda 4:00 ET; ações/ETF dos EUA, liq ≥ 500k, pesos iguais', liq: 5e5 },
};

// ---------------------------------------------------------------- horario de Nova York
const etFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
export function et(ts) {
  const p = Object.fromEntries(etFmt.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, wd: WD[p.weekday], hh: +p.hour % 24, mm: +p.minute };
}
const tradingDay = (e) => e.wd >= 1 && e.wd <= 5 && !HOLIDAYS.has(e.date);
/** proximo instante (grade de 15m, > from) cujo horario ET satisfaz pred */
function nextET(from, pred) {
  for (let t = Math.floor(from / BAR) * BAR + BAR, i = 0; i < 4 * 96 * 8; t += BAR, i++) if (pred(et(t))) return t;
  return null;
}

function getJSON(url, ms = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: ms }, (res) => {
      let s = ''; res.on('data', (d) => { s += d; });
      res.on('end', () => { try { res.statusCode === 200 ? resolve(JSON.parse(s)) : reject(new Error(`HTTP ${res.statusCode}`)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject);
  });
}

/**
 * Modo sombra: candidatos rodando ao vivo sem capital, com o resultado medido em dois precos:
 *   mid  = meio do livro na entrada e na saida (o "teorico", como os backtests)
 *   1k/5k = preco medio de uma ordem a mercado de US$1k / US$5k varrendo o livro gravado naquele instante
 * mais o funding real de cada hora. Estado em data/shadow/state.json, um trades.csv por candidato.
 */
export class Shadow {
  constructor({ dataDir, recorder, bars, live, classOf, markets, trend, momentum, fades }) {
    Object.assign(this, { recorder, bars, live, classOf, markets, trend, momentum, fades });
    this.dir = ensureDir(path.join(dataDir, 'shadow'));
    this.file = path.join(this.dir, 'state.json');
    this.st = readJSON(this.file, null) ?? { startedAt: Date.now(), pos: [], closed: [], fired: {}, nextId: 1 };
    Object.assign(this.st, { tbf: this.st.tbf ?? [], mom: this.st.mom ?? null, cap: this.st.cap ?? { hist: [], last: null, pending: null },
      rsi: this.st.rsi ?? {}, fdsRef: this.st.fdsRef ?? null, events: this.st.events ?? [] });
    this.csv = {};
    for (const k of ['capitulacao', 'overnight', 'rsi2', 'fds_acoes']) this.csv[k] = new CsvLog(path.join(this.dir, k, 'trades.csv'),
      ['id', 'event', 'sym', 'side', 'open_ts', 'close_ts', 'why', 'mid_in', 'mid_out', 'ex1k_in', 'ex1k_out', 'ex5k_in', 'ex5k_out',
        'cost1k_in', 'calm1k_in', 'funding_bp', 'bp_mid', 'bp_1k', 'bp_5k', 'info']);
    this.tbfCsv = new CsvLog(path.join(this.dir, 'fade_tbf', 'signals.csv'),
      ['bar', 'inst', 'sym', 'side', 'decision', 'tbf_lighter', 'n_lighter', 'usd_lighter', 'complete', 'tbf_binance', 'n_binance', 'usd_binance', 'binance_sym']);
    this.momCsv = new CsvLog(path.join(this.dir, 'mom_esticado', 'daily.csv'),
      ['T', 'base_bp', 'esticado_bp', 'diff_bp', 'base_cost_bp', 'esticado_cost_bp', 'excluidos', 'long_base', 'short_base', 'long_esticado', 'short_esticado']);
    this.capCsv = new CsvLog(path.join(this.dir, 'capitulacao', 'hourly.csv'), ['T', 'liquidos', 'n_le_m80', 'frac', 'evento']);
    this.flow = new Map(); // sym -> Map(barra -> {buy, tot, n}) dos negocios da Lighter
    this.stats = new Map(); this.bsyms = null; this.bsymsAt = 0;
  }

  save() { writeJSON(this.file, this.st); }
  log(msg) { log('SOMBRA', msg); }

  // ---------------------------------------------------------------- precos
  quote(sym, d) {
    const b = this.recorder.books.get(sym), t = b?.ready ? b.top() : null;
    const mid = t?.mid ?? this.live.lastPx.get(sym) ?? NaN;
    const ex = SIZES.map((u) => { if (!b?.ready) return NaN; const s = b.sweep(d > 0 ? 'buy' : 'sell', u); return s.complete ? s.avg : NaN; });
    return { mid, ex, cost1k: b?.ready ? b.cost(1000) : NaN, calm: this.recorder.calmCost(sym) };
  }

  open(strat, sym, d, { event = null, exitAt = null, info = '' } = {}) {
    if (this.st.pos.some((p) => p.strat === strat && p.sym === sym)) return null;
    const q = this.quote(sym, d), now = Date.now();
    if (!Number.isFinite(q.mid)) { this.log(`${strat}: ${sym} sem preço, não abriu`); return null; }
    const p = { id: this.st.nextId++, strat, sym, d, event, exitAt, info, openTs: now, midIn: q.mid, exIn: q.ex, cost1kIn: q.cost1k,
      calmIn: q.calm, fundBp: 0, lastFundingTs: this.stats.get(sym)?.funding_timestamp ?? now };
    this.st.pos.push(p);
    this.recorder.markHot(sym, 60 * MIN);
    return p;
  }

  close(p, why) {
    const q = this.quote(p.sym, -p.d), now = Date.now();
    const bp = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? p.d * (b / a - 1) * 1e4 + p.fundBp : NaN);
    const tr = { id: p.id, event: p.event, sym: p.sym, side: p.d > 0 ? 'long' : 'short', open_ts: new Date(p.openTs).toISOString(),
      close_ts: new Date(now).toISOString(), why, mid_in: p.midIn, mid_out: q.mid, ex1k_in: p.exIn[0], ex1k_out: q.ex[0], ex5k_in: p.exIn[1],
      ex5k_out: q.ex[1], cost1k_in: p.cost1kIn, calm1k_in: p.calmIn, funding_bp: p.fundBp, bp_mid: bp(p.midIn, q.mid),
      bp_1k: bp(p.exIn[0], q.ex[0]), bp_5k: bp(p.exIn[1], q.ex[1]), info: p.info };
    this.st.pos = this.st.pos.filter((x) => x !== p);
    this.st.closed.push({ strat: p.strat, ...tr, openTs: p.openTs, closeTs: now });
    if (this.st.closed.length > 5000) this.st.closed.splice(0, this.st.closed.length - 5000);
    this.csv[p.strat]?.append(tr);
    this.log(`${p.strat}: ${p.sym} ${tr.side} fechado (${why}) ${tr.bp_mid?.toFixed?.(1)}bp mid / ${Number.isFinite(tr.bp_1k) ? tr.bp_1k.toFixed(1) : '–'}bp US$1k`);
  }

  // ---------------------------------------------------------------- relogio (a cada 5s)
  start() {
    this.timer = setInterval(() => { try { this.tick(Date.now()); } catch (e) { log('ERRO', `sombra tick: ${e.stack}`); } }, 5000);
    this.ready = true;
  }

  /** dispara cada evento de horario uma unica vez (chave gravada no estado; sobrevive a reinicio) */
  once(key, fn) {
    if (this.st.fired[key]) return;
    this.st.fired[key] = Date.now();
    const ks = Object.keys(this.st.fired);
    if (ks.length > 400) for (const k of ks.slice(0, ks.length - 400)) delete this.st.fired[k];
    try { fn(); } catch (e) { log('ERRO', `sombra ${key}: ${e.stack}`); }
    this.save();
  }

  tick(now) {
    const slot = Math.floor(now / BAR) * BAR;
    if (now - slot >= 5000 && now - slot < 10 * MIN) { // so na janela logo apos a virada (evita disparo atrasado apos reinicio)
      const e = et(slot), hm = e.hh * 100 + e.mm;
      if (tradingDay(e) && hm === 1600) { this.once(`overnight:${e.date}`, () => this.overnightOpen(slot)); this.once(`rsi2:${e.date}`, () => this.rsiDaily(slot, e)); }
      if (e.wd === 5 && hm === 2000) this.once(`fdsref:${e.date}`, () => this.fdsRef(slot));
      if (e.wd === 0 && hm === 2000) this.once(`fds:${e.date}`, () => this.fdsOpen(slot));
    }
    // saidas por horario (inclusive as que venceram com o app parado)
    let changed = false;
    for (const p of [...this.st.pos]) if (p.exitAt && now >= p.exitAt) { this.close(p, now - p.exitAt > 15 * MIN ? 'atrasado (app parado)' : 'tempo'); changed = true; }
    const pc = this.st.cap.pending;
    if (pc && now >= pc.entryAt) { this.capEnter(pc); this.st.cap.pending = null; changed = true; }
    if (changed) this.save();
  }

  // ---------------------------------------------------------------- E1 overnight
  overnightOpen(T) {
    const R = RULES.overnight;
    const exitAt = nextET(T, (e) => tradingDay(e) && e.hh === 9 && e.mm === 0);
    const opened = R.syms.filter((s) => this.open('overnight', s, 1, { event: `on-${et(T).date}`, exitAt }));
    this.log(`overnight: compra ${opened.join(',') || '-'} até ${new Date(exitAt).toISOString().slice(0, 16)}Z`);
  }

  // ---------------------------------------------------------------- E2 RSI(2)
  /** fechamentos diarios das 16:00 ET (pregao) a partir dos candles 1h da tendencia + o mid de agora */
  dailyCloses(sym, T) {
    const out = [];
    for (const x of this.trend.load(sym)) {
      const end = x.t + H;
      if (end >= T) break;
      const e = et(end);
      if (e.hh === 16 && e.mm === 0 && tradingDay(e) && x.c > 0) out.push(x.c);
    }
    const m = this.quote(sym, 1).mid;
    if (Number.isFinite(m)) out.push(m);
    return out;
  }

  static rsi(c, n = 2) {
    if (c.length < n + 8) return NaN;
    let up = 0, dn = 0;
    for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; up += Math.max(d, 0); dn += Math.max(-d, 0); }
    up /= n; dn /= n;
    for (let i = n + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; up = (up * (n - 1) + Math.max(d, 0)) / n; dn = (dn * (n - 1) + Math.max(-d, 0)) / n; }
    return dn === 0 ? 100 : 100 - 100 / (1 + up / dn);
  }

  rsiDaily(T, e) {
    const R = RULES.rsi2, acts = [];
    for (const sym of R.syms) {
      const c = this.dailyCloses(sym, T), v = Shadow.rsi(c);
      this.st.rsi[sym] = { T, date: e.date, rsi: v, n: c.length, close: c.at(-1) };
      const p = this.st.pos.find((x) => x.strat === 'rsi2' && x.sym === sym);
      if (p && v > R.exit) { this.close(p, `RSI ${v.toFixed(0)} > ${R.exit}`); acts.push(`vende ${sym}`); }
      else if (!p && v < R.entry && this.open('rsi2', sym, 1, { event: `rsi-${sym}-${e.date}`, info: `RSI ${v.toFixed(1)}` })) acts.push(`compra ${sym}`);
    }
    this.log(`rsi2 ${e.date}: ${R.syms.map((s) => `${s} ${Number.isFinite(this.st.rsi[s].rsi) ? this.st.rsi[s].rsi.toFixed(0) : '–'}`).join(' · ')}${acts.length ? ' → ' + acts.join(', ') : ''}`);
  }

  // ---------------------------------------------------------------- E3 fim de semana em acoes
  fdsUniverse(T) {
    return this.markets().map((m) => m.symbol).filter((s) => ['acoes', 'etf_indice'].includes(this.classOf(s)) && !NON_US.has(s)
      && this.bars.features(s, T - BAR)?.liq >= RULES.fds_acoes.liq);
  }

  fdsRef(T) {
    const ref = {};
    for (const s of this.fdsUniverse(T)) { const m = this.quote(s, 1).mid; if (Number.isFinite(m)) ref[s] = m; }
    this.st.fdsRef = { T, ref };
    this.log(`fim de semana: referência de sexta 20:00 ET gravada (${Object.keys(ref).length} ativos)`);
  }

  fdsOpen(T) {
    const r = this.st.fdsRef;
    if (!r || T - r.T > 3 * DAY) return this.log('fim de semana: sem referência de sexta (app parado), pulado');
    const exitAt = nextET(T, (e) => e.wd === 1 && e.hh === 4 && e.mm === 0), ev = `fds-${et(T).date}`, out = [];
    for (const [s, m0] of Object.entries(r.ref)) {
      const m = this.quote(s, 1).mid, x = m / m0 - 1;
      if (!Number.isFinite(x) || x === 0) continue;
      if (this.open('fds_acoes', s, -Math.sign(x), { event: ev, exitAt, info: `x ${(x * 100).toFixed(2)}%` })) out.push(`${s} ${(x * 100).toFixed(1)}%`);
    }
    this.log(`fim de semana: ${out.length} posições contra o movimento (${out.join(', ')})`);
  }

  // ---------------------------------------------------------------- F1 capitulacao (chamado no fechamento de cada barra)
  onBarClose(T) {
    if (!this.ready || T % H !== 0 || this.st.cap.hist.at(-1)?.T === T) return;
    const v = this.trend.view(0);
    if (v.T !== T || !v.rows.length) return;
    const R = RULES.capitulacao;
    const liq = v.rows.filter((r) => r.cls === 'cripto' && this.bars.features(r.sym, T - BAR)?.liq >= R.liq && Number.isFinite(r.sets.curto?.score));
    const low = liq.filter((r) => r.sets.curto.score <= R.score);
    const frac = liq.length ? low.length / liq.length : NaN;
    const ev = frac >= R.frac && (!this.st.cap.last || T - this.st.cap.last >= R.gapD * DAY) && !this.st.cap.pending;
    this.st.cap.hist.push({ T, n: liq.length, low: low.length, frac });
    if (this.st.cap.hist.length > 24 * 30) this.st.cap.hist.shift();
    this.capCsv.append({ T: new Date(T).toISOString(), liquidos: liq.length, n_le_m80: low.length, frac, evento: ev ? 1 : 0 });
    if (ev) {
      const basket = [...liq].sort((a, b) => a.sets.curto.score - b.sets.curto.score).slice(0, R.n).map((r) => ({ sym: r.sym, score: r.sets.curto.score }));
      this.st.cap.last = T;
      this.st.cap.pending = { T, frac, basket, entryAt: T + R.delayH * H };
      this.st.events.unshift({ strat: 'capitulacao', T, frac, basket }); this.st.events.length = Math.min(this.st.events.length, 50);
      this.log(`capitulação: ${(frac * 100).toFixed(0)}% dos ${liq.length} líquidos com score ≤ ${R.score}; compra em 1h: ${basket.map((b) => b.sym).join(',')}`);
    }
    this.save();
  }

  capEnter(pc) {
    const R = RULES.capitulacao, ev = `cap-${new Date(pc.T).toISOString().slice(0, 13)}`;
    for (const b of pc.basket) this.open('capitulacao', b.sym, 1, { event: ev, exitAt: pc.entryAt + R.holdH * H, info: `score ${b.score.toFixed(0)}` });
    this.log(`capitulação: comprou ${pc.basket.map((b) => b.sym).join(',')}`);
  }

  // ---------------------------------------------------------------- B3: fluxo agressor nos sinais do fade
  onTrade(sym, x) {
    const t = Math.floor(x.timestamp / BAR) * BAR, usd = +x.usd_amount;
    if (!(usd > 0)) return;
    let m = this.flow.get(sym);
    if (!m) this.flow.set(sym, (m = new Map()));
    const a = m.get(t) ?? { buy: 0, tot: 0, n: 0 };
    if (x.is_maker_ask) a.buy += usd; // maker no ask = agressor comprou (mesma convencao do trades.csv)
    a.tot += usd; a.n++;
    m.set(t, a);
    if (m.size > 12) m.delete(m.keys().next().value);
  }

  async binanceSym(sym) {
    if (!this.bsyms || Date.now() - this.bsymsAt > DAY) {
      try {
        const info = await getJSON('https://fapi.binance.com/fapi/v1/exchangeInfo', 15000);
        this.bsyms = new Set(info.symbols.filter((s) => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT').map((s) => s.symbol));
        this.bsymsAt = Date.now();
      } catch (e) { log('AVISO', `sombra: exchangeInfo da Binance: ${e.message}`); return null; }
    }
    for (const c of [sym + 'USDT', '1000' + sym + 'USDT', sym.replace(/^1000/, '') + 'USDT']) if (this.bsyms.has(c)) return c;
    return null;
  }

  /** depois do scan de cada instancia do fade: grava o fluxo da barra k de cada sinal novo */
  async onFadeScan(k) {
    const rows = [];
    for (const f of this.fades) {
      for (const s of f.st.signals) {
        if (s.k !== k) continue;
        if (this.st.tbf.some((r) => r.k === k && r.sym === s.sym && r.inst === f.name)) continue;
        const a = this.flow.get(s.sym)?.get(k);
        const r = { k, inst: f.name, sym: s.sym, side: s.side, cls: s.cls, tbfL: a?.tot ? a.buy / a.tot : NaN, nL: a?.n ?? 0, usdL: a?.tot ?? 0,
          complete: (this.live.subAt.get(s.sym) ?? Infinity) <= k, tbfB: NaN, nB: null, usdB: null, bsym: null };
        rows.push(r); this.st.tbf.unshift(r);
      }
    }
    if (!rows.length) return;
    this.st.tbf.length = Math.min(this.st.tbf.length, 3000);
    for (const r of rows) {
      if (r.cls !== 'cripto') continue;
      try {
        r.bsym = await this.binanceSym(r.sym);
        if (!r.bsym) continue;
        const kl = await getJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${r.bsym}&interval=15m&startTime=${k}&limit=1`);
        if (kl?.[0]?.[0] === k) { r.usdB = +kl[0][7]; r.nB = +kl[0][8]; r.tbfB = r.usdB > 0 ? +kl[0][10] / r.usdB : NaN; }
      } catch (e) { log('AVISO', `sombra: kline Binance ${r.sym}: ${e.message}`); }
    }
    for (const r of rows) this.tbfCsv.append({ bar: new Date(k).toISOString(), inst: r.inst, sym: r.sym, side: r.side,
      decision: this.fades.find((f) => f.name === r.inst)?.st.signals.find((s) => s.k === k && s.sym === r.sym)?.decision,
      tbf_lighter: r.tbfL, n_lighter: r.nL, usd_lighter: r.usdL, complete: r.complete ? 1 : 0, tbf_binance: r.tbfB, n_binance: r.nB, usd_binance: r.usdB, binance_sym: r.bsym });
    this.log(`fade×fluxo: ${rows.map((r) => `${r.inst} ${r.sym} tbf L ${Number.isFinite(r.tbfL) ? r.tbfL.toFixed(2) : '–'} / B ${Number.isFinite(r.tbfB) ? r.tbfB.toFixed(2) : '–'}`).join(' · ')}`);
    this.save();
  }

  // ---------------------------------------------------------------- momentum sem esticados (teorico, 1x bruto)
  momTargets(k, syms) {
    const M = this.momentum, R = RULES.mom_esticado, C = M.cfg;
    const tg = M.target(k, syms);
    const names = Object.keys(tg.elig).sort();
    const w = {}, excl = [];
    if (names.length >= 2 * C.perSide) {
      const o = names.map((s, i) => [s, i]).sort((a, b) => tg.elig[a[0]].key - tg.elig[b[0]].key || a[1] - b[1]).map((x) => x[0]);
      const stretched = (s, d) => {
        const f = tg.elig[s], c0 = M.bars.bar(s, k - R.L * 96 * BAR)?.c;
        if (!c0) return false;
        return d * (f.c / c0 - 1) >= R.g * f.vol * Math.sqrt(R.L);
      };
      const pick = (list, d) => { const out = []; for (const s of list) { if (out.length >= C.perSide) break; if (stretched(s, d)) excl.push(s); else out.push(s); } return out; };
      const long = pick([...o].reverse(), 1), short = pick(o.filter((s) => !long.includes(s)), -1);
      if (long.length === C.perSide && short.length === C.perSide) {
        for (const s of long) w[s] = 0.5 / C.perSide;
        for (const s of short) w[s] = -0.5 / C.perSide;
      }
      return { base: tg.w, str: w, excl, long, short, baseLong: tg.long, baseShort: tg.short };
    }
    return { base: tg.w, str: {}, excl, long: [], short: [], baseLong: [], baseShort: [] };
  }

  /** chamado depois do rebalanceamento do momentum do paper (barra T) */
  onMomentum(T) {
    const M = this.momentum;
    if (!M?.ready || M.st.lastT !== T || this.st.mom?.T === T) return;
    const k = T - BAR, syms = M.cryptoMarkets().map((m) => m.symbol), C = M.cfg;
    const cur = this.momTargets(k, syms);
    let mo = this.st.mom;
    if (!mo) { // primeira vez: reconstroi as H-1 metas anteriores (carteira ja em regime), como o paper
      mo = { T: null, v: { base: { targets: [], hold: {}, lastC: {}, fpend: 0 }, str: { targets: [], hold: {}, lastC: {}, fpend: 0 } }, daily: [] };
      for (let d = C.holdDays - 1; d >= 1; d--) {
        const x = this.momTargets(k - d * DAY, syms);
        mo.v.base.targets.push({ T: T - d * DAY, w: x.base }); mo.v.str.targets.push({ T: T - d * DAY, w: x.str });
      }
    }
    const close = (s) => M.bars.bar(s, k)?.c;
    const row = { T };
    for (const [name, w] of [['base', cur.base], ['str', cur.str]]) {
      const v = mo.v[name];
      let r = 0;
      for (const [s, h] of Object.entries(v.hold)) { const c1 = close(s), c0 = v.lastC[s]; if (c1 && c0) r += h * (c1 / c0 - 1); }
      v.targets = v.targets.filter((x) => x.T < T).concat([{ T, w }]).slice(-C.holdDays);
      const hold = {};
      for (const t of v.targets) for (const [s, x] of Object.entries(t.w)) hold[s] = (hold[s] ?? 0) + x / v.targets.length;
      let cost = 0;
      for (const s of new Set([...Object.keys(hold), ...Object.keys(v.hold)])) {
        const dw = Math.abs((hold[s] ?? 0) - (v.hold[s] ?? 0));
        if (dw <= 0) continue;
        const c = this.recorder.books.get(s)?.ready ? this.recorder.books.get(s).cost(1000) : NaN;
        cost += dw * (Number.isFinite(c) ? c : 0.0015);
      }
      const first = mo.T === null;
      row[name] = first ? null : (r + v.fpend - cost) * 1e4; row[name + 'Cost'] = cost * 1e4;
      v.hold = hold; v.fpend = 0;
      v.lastC = Object.fromEntries(Object.keys(hold).map((s) => [s, close(s)]).filter((x) => x[1] > 0));
    }
    mo.T = T;
    const d = { T, base: row.base, str: row.str, diff: Number.isFinite(row.base) && Number.isFinite(row.str) ? row.str - row.base : null,
      baseCost: row.baseCost, strCost: row.strCost, excl: cur.excl, long: cur.long, short: cur.short, baseLong: cur.baseLong, baseShort: cur.baseShort };
    mo.daily.push(d); if (mo.daily.length > 400) mo.daily.shift();
    this.st.mom = mo;
    this.momCsv.append({ T: new Date(T).toISOString(), base_bp: d.base, esticado_bp: d.str, diff_bp: d.diff, base_cost_bp: d.baseCost, esticado_cost_bp: d.strCost,
      excluidos: cur.excl.join(' '), long_base: cur.baseLong.join(' '), short_base: cur.baseShort.join(' '), long_esticado: cur.long.join(' '), short_esticado: cur.short.join(' ') });
    this.log(`momentum sem esticados: excluídos ${cur.excl.join(',') || 'nenhum'} | compra ${cur.long.join(',')} | vende ${cur.short.join(',')}` +
      (Number.isFinite(d.diff) ? ` | dia base ${d.base.toFixed(1)}bp, variante ${d.str.toFixed(1)}bp` : ''));
    this.save();
  }

  // ---------------------------------------------------------------- funding (market_stats)
  onStats(sym, ms) {
    const prev = this.stats.get(sym);
    this.stats.set(sym, ms);
    if (!ms.funding_timestamp || (prev && prev.funding_timestamp === ms.funding_timestamp)) return;
    const rate = +ms.funding_rate; // %/h, positivo = comprados pagam
    for (const p of this.st.pos) {
      if (p.sym !== sym || ms.funding_timestamp <= p.lastFundingTs || ms.funding_timestamp <= p.openTs) continue;
      p.fundBp += -p.d * rate * 100; p.lastFundingTs = ms.funding_timestamp;
    }
    const mo = this.st.mom;
    if (mo) for (const v of Object.values(mo.v)) { const w = v.hold[sym]; if (w) v.fpend += -w * rate / 100; }
  }

  // ---------------------------------------------------------------- dashboard
  view() {
    const mean = (xs) => { const a = xs.filter(Number.isFinite); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; };
    const sum = (xs) => xs.filter(Number.isFinite).reduce((x, y) => x + y, 0);
    const tstat = (xs) => { const a = xs.filter(Number.isFinite); if (a.length < 3) return null; const m = mean(a), sd = Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); return sd > 0 ? m / (sd / Math.sqrt(a.length)) : null; };
    const strat = {};
    for (const k of ['capitulacao', 'overnight', 'rsi2', 'fds_acoes']) {
      const c = this.st.closed.filter((t) => t.strat === k);
      const ev = {}; // por evento (cesta/noite/fim de semana): media das pernas
      for (const t of c) (ev[t.event] ??= []).push(t);
      const evs = Object.values(ev).map((x) => ({ mid: mean(x.map((t) => t.bp_mid)), k1: mean(x.map((t) => t.bp_1k)) }));
      strat[k] = { ...RULES[k], n: c.length, events: evs.length, open: this.st.pos.filter((p) => p.strat === k).length,
        bpMid: mean(c.map((t) => t.bp_mid)), bp1k: mean(c.map((t) => t.bp_1k)), bp5k: mean(c.map((t) => t.bp_5k)),
        fund: mean(c.map((t) => t.funding_bp)), win: c.length ? c.filter((t) => t.bp_1k > 0).length / c.filter((t) => Number.isFinite(t.bp_1k)).length : null,
        evMid: mean(evs.map((e) => e.mid)), ev1k: mean(evs.map((e) => e.k1)), evT: tstat(evs.map((e) => e.k1)),
        sumEv1k: sum(evs.map((e) => e.k1)), cost: mean(c.map((t) => t.cost1k_in * 1e4)), calm: mean(c.map((t) => t.calm1k_in * 1e4)) };
    }
    // B3: resultado real dos trades do fade/C2 por faixa de tbf
    const closedBy = new Map();
    for (const f of this.fades) for (const t of f.st.closed) closedBy.set(`${f.name}|${t.signal_bar}|${t.sym}`, t);
    const decOf = (r) => this.fades.find((f) => f.name === r.inst)?.st.signals.find((s) => s.k === r.k && s.sym === r.sym)?.decision;
    const rows = this.st.tbf.map((r) => { const t = closedBy.get(`${r.inst}|${r.k}|${r.sym}`); return { ...r, decision: t ? 'fechado' : decOf(r) ?? '–', R: t?.R_real ?? null, Rtheo: t?.R_theo_net ?? null }; });
    const grp = (key) => {
      const done = rows.filter((r) => Number.isFinite(r.R) && Number.isFinite(r[key]));
      const hi = done.filter((r) => r[key] >= RULES.fade_tbf.corte), lo = done.filter((r) => r[key] < RULES.fade_tbf.corte);
      return { nHi: hi.length, nLo: lo.length, RHi: mean(hi.map((r) => r.R)), RLo: mean(lo.map((r) => r.R)) };
    };
    const both = rows.filter((r) => Number.isFinite(r.tbfL) && Number.isFinite(r.tbfB) && r.complete);
    let corr = null;
    if (both.length >= 5) {
      const mx = mean(both.map((r) => r.tbfL)), my = mean(both.map((r) => r.tbfB));
      let sxy = 0, sxx = 0, syy = 0;
      for (const r of both) { sxy += (r.tbfL - mx) * (r.tbfB - my); sxx += (r.tbfL - mx) ** 2; syy += (r.tbfB - my) ** 2; }
      corr = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
    }
    const mo = this.st.mom, md = (mo?.daily ?? []).filter((d) => Number.isFinite(d.diff));
    const posView = this.st.pos.map((p) => {
      const q = this.quote(p.sym, -p.d);
      return { ...p, midNow: q.mid, bpMid: Number.isFinite(q.mid) ? p.d * (q.mid / p.midIn - 1) * 1e4 + p.fundBp : null };
    });
    return {
      startedAt: this.st.startedAt, rules: RULES, strat, pos: posView,
      closed: this.st.closed.slice(-150).reverse(),
      tbf: { ...RULES.fade_tbf, n: rows.length, lighter: grp('tbfL'), binance: grp('tbfB'), corr, nBoth: both.length,
        medL: mean(rows.map((r) => r.tbfL)), medB: mean(rows.map((r) => r.tbfB)), rows: rows.slice(0, 80) },
      mom: { ...RULES.mom_esticado, days: md.length, base: mean(md.map((d) => d.base)), str: mean(md.map((d) => d.str)), diff: mean(md.map((d) => d.diff)),
        diffT: tstat(md.map((d) => d.diff)), sumBase: sum(md.map((d) => d.base)), sumStr: sum(md.map((d) => d.str)),
        exclDays: md.filter((d) => d.excl.length).length, daily: (mo?.daily ?? []).slice(-60).reverse() },
      cap: { ...RULES.capitulacao, hist: this.st.cap.hist.slice(-72), last: this.st.cap.last, pending: this.st.cap.pending, events: this.st.events.filter((e) => e.strat === 'capitulacao') },
      rsi: this.st.rsi, fdsRef: this.st.fdsRef ? { T: this.st.fdsRef.T, n: Object.keys(this.st.fdsRef.ref).length } : null,
      next: this.nextEvents(Date.now()),
    };
  }

  nextEvents(now) {
    const n = (pred) => nextET(now, pred);
    return { overnight: n((e) => tradingDay(e) && e.hh === 16 && e.mm === 0), fdsRef: n((e) => e.wd === 5 && e.hh === 20 && e.mm === 0),
      fds: n((e) => e.wd === 0 && e.hh === 20 && e.mm === 0), momentum: this.momentum ? this.momentum.scheduledT(now) + DAY : null };
  }
}
