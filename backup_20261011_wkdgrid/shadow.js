import path from 'node:path';
import https from 'node:https';
import { BAR, log, readJSON, writeJSON, ensureDir, CsvLog } from './util.js';
import { FundingDiff, FDIFF } from './fdiff.js';
import { QuadTurb, QT } from './quadturb.js';

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
  fade_mom: { titulo: 'Fade × lado do momentum (H4)', secao: 34,
    regra: 'marca cada sinal do fade e do C2 com o lado do momentum do paper no ativo (carteira em vigor); hipótese: fade contra uma perna comprada do momentum rende mais (backtest +0,24R × +0,09R); variante: tamanho 1,5× nesses sinais, 1× nos demais', mult: 1.5 },
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
  fdiff: FDIFF, // diferencial de funding Lighter - Binance (src/fdiff.js)
  quad_turb: QT, // quad rotation em turbulencia, candles 1m da Binance (src/quadturb.js)
  mom_voltarget: { titulo: 'Momentum com alvo de vol', secao: 'TREND 16.8',
    regra: 'retorno do dia = momentum do paper (teórico, por unidade de bruto) × k; k = 0,75 × vol 365d / vol 30d dos retornos diários da própria estratégia (backtest + paper) até a véspera, entre 0 e 1,5×; custo de ajustar a exposição quando k muda; comparado com k = 1',
    win: 30, ref: 365, minWin: 10, minRef: 60, scale: 0.75, cap: 1.5 },
  resultado: { titulo: 'Resultados trimestrais (E4)', secao: 43,
    regra: 'ação dos EUA com resultado depois do fechamento (calendário da Nasdaq do dia: "after-hours"; "not-supplied" só se o perp negociar ≥ 20% do volume de 24h entre 16h e 18h ET): sinal = sign(fech. 18:00 / fech. 16:00 − 1) nas barras de 15m; entra a favor às 18:15 ET e sai às 9:30 ET do pregão seguinte; sem filtro de liquidez',
    share: 0.20, lateMin: 30, esperado: { liq: 111, bruto: 140, n: 60 } },
};

const TRADE_STRATS = ['capitulacao', 'overnight', 'rsi2', 'fds_acoes', 'resultado', 'quad_turb']; // um trades.csv por candidato

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

function getJSON(url, ms = 8000, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: ms, headers }, (res) => {
      let s = ''; res.on('data', (d) => { s += d; });
      res.on('end', () => { try { res.statusCode === 200 ? resolve(JSON.parse(s)) : reject(new Error(`HTTP ${res.statusCode}`)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject);
  });
}

// calendario de resultados da Nasdaq (publico; pede cabecalhos de navegador)
const NASDAQ_HDR = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*', Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' };
/** [{symbol, time}] do dia (time: 'after-hours' | 'pre-market' | 'not-supplied') */
async function nasdaqEarnings(date) {
  const j = await getJSON(`https://api.nasdaq.com/api/calendar/earnings?date=${date}`, 20000, NASDAQ_HDR);
  return (j?.data?.rows ?? []).map((r) => ({ symbol: String(r.symbol).trim(), time: String(r.time ?? '').replace('time-', '') }));
}

/**
 * Modo sombra: candidatos rodando ao vivo sem capital, com o resultado medido em dois precos:
 *   mid  = meio do livro na entrada e na saida (o "teorico", como os backtests)
 *   1k/5k = preco medio de uma ordem a mercado de US$1k / US$5k varrendo o livro gravado naquele instante
 * mais o funding real de cada hora. Estado em data/shadow/state.json, um trades.csv por candidato.
 */
export class Shadow {
  constructor({ dataDir, recorder, bars, live, classOf, markets, trend, momentum, fades, rest }) {
    Object.assign(this, { recorder, bars, live, classOf, markets, trend, momentum, fades });
    // diferencial de funding: carteira propria em data/shadow/fdiff (precisa do REST da Lighter para o historico de funding)
    try { this.fdiff = rest ? new FundingDiff({ dataDir, rest, bars, trend, recorder, live, classOf, markets }) : null; }
    catch (e) { this.fdiff = null; log('ERRO', `sombra: diferencial de funding desligado: ${e.stack}`); }
    this.dir = ensureDir(path.join(dataDir, 'shadow'));
    this.file = path.join(this.dir, 'state.json');
    this.st = readJSON(this.file, null) ?? { startedAt: Date.now(), pos: [], closed: [], fired: {}, nextId: 1 };
    Object.assign(this.st, { tbf: this.st.tbf ?? [], mom: this.st.mom ?? null, cap: this.st.cap ?? { hist: [], last: null, pending: null },
      rsi: this.st.rsi ?? {}, fdsRef: this.st.fdsRef ?? null, events: this.st.events ?? [], vt: this.st.vt ?? { rows: [] },
      res: this.st.res ?? { days: {}, dec: [], upcoming: null } });
    this.csv = {};
    for (const k of TRADE_STRATS) this.csv[k] = new CsvLog(path.join(this.dir, k, 'trades.csv'),
      ['id', 'event', 'sym', 'side', 'open_ts', 'close_ts', 'why', 'mid_in', 'mid_out', 'ex1k_in', 'ex1k_out', 'ex5k_in', 'ex5k_out',
        'cost1k_in', 'calm1k_in', 'funding_bp', 'bp_mid', 'bp_1k', 'bp_5k', 'info']);
    this.tbfCsv = new CsvLog(path.join(this.dir, 'fade_tbf', 'signals.csv'),
      ['bar', 'inst', 'sym', 'side', 'decision', 'tbf_lighter', 'n_lighter', 'usd_lighter', 'complete', 'tbf_binance', 'n_binance', 'usd_binance', 'binance_sym']);
    this.momCsv = new CsvLog(path.join(this.dir, 'mom_esticado', 'daily.csv'),
      ['T', 'base_bp', 'esticado_bp', 'diff_bp', 'base_cost_bp', 'esticado_cost_bp', 'excluidos', 'long_base', 'short_base', 'long_esticado', 'short_esticado']);
    this.capCsv = new CsvLog(path.join(this.dir, 'capitulacao', 'hourly.csv'), ['T', 'liquidos', 'n_le_m80', 'frac', 'evento']);
    this.vtCsv = new CsvLog(path.join(this.dir, 'mom_voltarget', 'daily.csv'),
      ['T', 'base_bp', 'k', 'alvo_bp', 'ajuste_custo_bp', 'alvo_liq_bp', 'k_proximo', 'vol30_ano', 'vol365_ano', 'reconstruido']);
    this.resCsv = new CsvLog(path.join(this.dir, 'resultado', 'decisions.csv'),
      ['date', 'sym', 'nasdaq_time', 'c16', 'c17', 'c18', 'R17_bp', 'R18_bp', 'share_16_18', 'v24', 'evento', 'motivo', 'lado', 'trade_id']);
    this.fetchEarnings = nasdaqEarnings; this.resPause = 1500; // trocados nos testes
    this.resBusy = false;
    this.flow = new Map(); // sym -> Map(barra -> {buy, tot, n}) dos negocios da Lighter
    this.stats = new Map(); this.bsyms = null; this.bsymsAt = 0;
    // quad em turbulencia: candles 1m da Binance a cada minuto, estado proprio em data/shadow/quad_turb
    try { this.qt = new QuadTurb({ dataDir, shadow: this }); }
    catch (e) { this.qt = null; log('ERRO', `sombra: quad em turbulência desligado: ${e.stack}`); }
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
    try { this.qt?.start(); } catch (e) { log('ERRO', `sombra quad em turbulência: ${e.stack}`); }
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
    try { this.resTick(now, slot); } catch (e) { log('ERRO', `sombra resultado: ${e.stack}`); }
    // saidas por horario (inclusive as que venceram com o app parado)
    let changed = false;
    for (const p of [...this.st.pos]) {
      if (!p.exitAt || now < p.exitAt) continue;
      // quad em turbulencia: com a Lighter parada (sem negocio ha 5+ min) a saida espera o livro voltar, ate 6h
      if (p.strat === 'quad_turb' && this.qt && !this.qt.fresh(p.sym, now) && now - p.exitAt < 6 * H) {
        if (!p.waitSince) { p.waitSince = now; this.log(`quad_turb: ${p.sym} sem negócio na Lighter, saída adiada`); changed = true; }
        continue;
      }
      this.close(p, p.waitSince ? 'tempo (adiado: Lighter parada)' : now - p.exitAt > 15 * MIN ? 'atrasado (app parado)' : 'tempo'); changed = true;
    }
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

  // ---------------------------------------------------------------- E4 resultados trimestrais (secao 43)
  resUniverse() {
    return new Set(this.markets().map((m) => m.symbol).filter((s) => this.classOf(s) === 'acoes' && !NON_US.has(s)));
  }

  /** 15:00-18:15 ET: busca o calendario do dia (novas tentativas a cada minuto); a partir das 18:15 ET: decide e abre */
  resTick(now, slot) {
    const e = et(slot);
    if (!tradingDay(e)) return;
    const R = RULES.resultado, hm = e.hh * 100 + e.mm, day = this.st.res.days[e.date];
    if (hm >= 1500 && hm < 1815 && !day?.cal && !this.resBusy && now - (day?.lastTry ?? 0) > 60_000 && (day?.tries ?? 0) < 120) this.resFetch(e.date, now);
    const m = e.hh * 60 + e.mm - (18 * 60 + 15); // minutos desde a virada das 18:15 ET
    if (m < 0 || m >= R.lateMin || !day || day.decided) return;
    const T1815 = slot - m * MIN;
    if (!day.cal) {
      if (!day.missed) { day.missed = now; this.log(`resultado ${e.date}: sem o calendário da Nasdaq às 18:15 ET (${day.err ?? 'não buscado'}); dia perdido se não chegar até 18:${15 + R.lateMin}`); this.save(); }
      return;
    }
    if (!(this.bars.lastRefresh >= T1815 - BAR)) return; // espera as barras de 15m ate a das 17:45
    this.resDecide(e.date, T1815, now);
  }

  resFetch(date, now) {
    const d = (this.st.res.days[date] ??= { tries: 0 });
    d.tries++; d.lastTry = now; this.resBusy = true;
    const uni = this.resUniverse();
    this.fetchEarnings(date).then((rows) => {
      d.cal = Object.fromEntries(rows.filter((r) => uni.has(r.symbol)).map((r) => [r.symbol, r.time]));
      d.nRows = rows.length; d.fetchedAt = Date.now(); d.err = null;
      this.log(`resultado ${date}: calendário da Nasdaq com ${rows.length} empresas; com perp na Lighter: ${Object.entries(d.cal).map(([s, t]) => `${s} (${t})`).join(', ') || 'nenhuma'}`);
      const ks = Object.keys(this.st.res.days).sort();
      for (const k of ks.slice(0, Math.max(0, ks.length - 30))) delete this.st.res.days[k];
      this.save();
      if (this.st.res.upcoming?.date !== date) this.resUpcoming(date, uni).catch((err) => this.log(`resultado: próximos dias falharam (${err.message})`));
    }).catch((err) => {
      d.err = err.message;
      if (d.tries % 15 === 1) this.log(`resultado ${date}: calendário da Nasdaq falhou (${err.message}), tentativa ${d.tries}`);
    }).finally(() => { this.resBusy = false; });
  }

  /** proximos 14 dias corridos (so para o painel; a decisao usa sempre o calendario do proprio dia) */
  async resUpcoming(date, uni) {
    const list = [];
    for (let i = 1; i <= 14; i++) {
      const x = et(Date.parse(`${date}T12:00:00Z`) + i * DAY);
      if (!tradingDay(x)) continue;
      try { for (const r of await this.fetchEarnings(x.date)) if (uni.has(r.symbol)) list.push({ date: x.date, sym: r.symbol, time: r.time }); }
      catch (err) { list.push({ date: x.date, sym: '?', time: `falhou: ${err.message}` }); }
      await new Promise((r) => setTimeout(r, this.resPause));
    }
    this.st.res.upcoming = { date, fetchedAt: Date.now(), list };
    this.save();
  }

  resDecide(date, T1815, now) {
    const R = RULES.resultado, day = this.st.res.days[date];
    day.decided = now;
    const T16 = T1815 - 135 * MIN, T17 = T1815 - 75 * MIN, T18 = T1815 - 15 * MIN;
    const exitAt = nextET(T1815, (x) => tradingDay(x) && x.hh === 9 && x.mm === 30);
    const late = now - T1815 > 2 * MIN, out = [];
    // fechamento da ultima barra de 15m que termina em tEnd (aceita ate 1h sem negocio, como o ffill(limit=4) do backtest)
    const closeAt = (b, tEnd) => { for (let i = b.length - 1; i >= 0; i--) { const z = b[i].t + BAR; if (z <= tEnd) return z > tEnd - H ? b[i].c : NaN; } return NaN; };
    for (const [sym, time] of Object.entries(day.cal)) {
      const b = this.bars.load(sym);
      const c16 = closeAt(b, T16), c17 = closeAt(b, T17), c18 = closeAt(b, T18);
      const vol = (a, z) => b.reduce((s, x) => s + (x.t >= a && x.t < z && x.V > 0 ? x.V : 0), 0);
      const v24 = vol(T16 - DAY, T16), share = v24 > 0 ? vol(T16, T18) / v24 : NaN;
      const R17 = c17 / c16 - 1, R18 = c18 / c16 - 1;
      let ev = false, why;
      if (time === 'pre-market') why = 'antes da abertura';
      else if (time === 'after-hours') { ev = true; why = 'after-hours'; }
      else if (share >= R.share) { ev = true; why = `sem horário; volume 16–18h = ${(share * 100).toFixed(0)}% do de 24h`; }
      else why = `sem horário; volume 16–18h = ${Number.isFinite(share) ? (share * 100).toFixed(0) + '%' : '–'} do de 24h (< ${R.share * 100}%)`;
      if (ev && !(Number.isFinite(R18) && R18 !== 0)) { ev = false; why += '; sem preço às 16h ou 18h'; }
      const p = ev ? this.open('resultado', sym, Math.sign(R18), { event: `res-${sym}-${date}`, exitAt,
        info: `R 16→18h ${(R18 * 100).toFixed(2)}% · ${time}${late ? ' · entrada atrasada' : ''}` }) : null;
      if (ev && !p) why += '; não abriu (sem livro)';
      const side = p ? (p.d > 0 ? 'long' : 'short') : null;
      this.st.res.dec.unshift({ T: T1815, date, sym, time, c16, c17, c18, R17, R18, share, v24, ev: !!p, why, side, id: p?.id ?? null });
      this.resCsv.append({ date, sym, nasdaq_time: time, c16, c17, c18, R17_bp: R17 * 1e4, R18_bp: R18 * 1e4, share_16_18: share, v24,
        evento: p ? 1 : 0, motivo: why, lado: side ?? '', trade_id: p?.id ?? '' });
      out.push(`${sym} ${side ?? '–'} (${why})`);
    }
    this.st.res.dec.length = Math.min(this.st.res.dec.length, 300);
    this.log(`resultado ${date}: ${out.join(' · ') || 'nenhuma ação da Lighter com resultado hoje'}`);
    this.save();
  }

  // ---------------------------------------------------------------- F1 capitulacao (chamado no fechamento de cada barra)
  onBarClose(T) {
    if (this.ready) this.fdiff?.onBarClose(T).catch((e) => log('ERRO', `sombra fdiff: ${e.stack}`)); // assincrono (APIs de funding)
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

  /** lado do momentum do paper no ativo agora: 1 comprado, -1 vendido, 0 fora (null se o momentum nao esta rodando) */
  momSide(sym) {
    const h = this.momentum?.st?.theo?.hold;
    return h ? Math.sign(h[sym] ?? 0) : null;
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
          complete: (this.live.subAt.get(s.sym) ?? Infinity) <= k, mom: this.momSide(s.sym), tbfB: NaN, nB: null, usdB: null, bsym: null };
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

  // ---------------------------------------------------------------- momentum com alvo de vol (TREND 16.8)
  /** k = clip(scale * sd(ultimos ref) / sd(ultimos win), 0, cap) sobre a serie ate a vespera; 1 sem historico (= study_mom_voltarget.vt) */
  static vtK(xs, R) {
    const sd = (a) => { const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
    const a = xs.slice(-R.win), b = xs.slice(-R.ref);
    if (a.length < R.minWin || b.length < R.minRef) return { k: 1, v30: NaN, v365: NaN };
    const v30 = sd(a), v365 = sd(b);
    return { k: v30 > 0 ? Math.min(R.cap, Math.max(0, R.scale * v365 / v30)) : 1, v30, v365 };
  }

  /** serie diaria do momentum por unidade de bruto: backtest (prior) + teorico do paper depois dele; [{T, x}] em ordem */
  vtSeries() {
    const M = this.momentum, p = M.prior ?? {}, out = [];
    (p.ts ?? []).forEach((t, i) => { if (Number.isFinite(p.r?.[i])) out.push({ T: t, x: p.r[i], live: false }); });
    const last = out.at(-1)?.T ?? -Infinity;
    for (const d of M.st.daily) if (d.T > last && Number.isFinite(d.theo)) out.push({ T: d.T, x: d.theo, live: true });
    return out.sort((a, b) => a.T - b.T);
  }

  /** depois de cada rebalanceamento: uma linha por dia do paper ainda nao registrado (os anteriores ao inicio sao reconstruidos) */
  volTarget(T) {
    const M = this.momentum, R = RULES.mom_voltarget, vt = this.st.vt;
    const ser = this.vtSeries(), lastT = vt.rows.at(-1)?.T ?? -Infinity;
    const hold = M.st.theo?.hold ?? {};
    let book = 0; // custo por unidade de bruto para ajustar a carteira inteira (custo de US$1k de cada perna)
    for (const [s, w] of Object.entries(hold)) { const c = this.recorder.books.get(s)?.ready ? this.recorder.books.get(s).cost(1000) : NaN; book += Math.abs(w) * (Number.isFinite(c) ? c : 0.0015); }
    let added = 0;
    for (let i = 0; i < ser.length; i++) {
      const d = ser[i];
      if (!d.live || d.T <= lastT || d.T > T) continue;
      const xs = ser.slice(0, i).map((y) => y.x);
      const used = Shadow.vtK(xs, R), nxt = Shadow.vtK([...xs, d.x], R);
      const rebuilt = d.T !== T;
      const adj = rebuilt ? 0 : Math.abs(nxt.k - used.k) * book; // reconstruidos: sem livro da epoca, sem custo de ajuste
      const row = { T: d.T, base: d.x * 1e4, k: used.k, alvo: used.k * d.x * 1e4, adj: adj * 1e4, alvoLiq: (used.k * d.x - adj) * 1e4,
        kNext: nxt.k, v30: nxt.v30 * Math.sqrt(365), v365: nxt.v365 * Math.sqrt(365), rebuilt };
      vt.rows.push(row); added++;
      this.vtCsv.append({ T: new Date(d.T).toISOString(), base_bp: row.base, k: row.k, alvo_bp: row.alvo, ajuste_custo_bp: row.adj, alvo_liq_bp: row.alvoLiq,
        k_proximo: row.kNext, vol30_ano: row.v30, vol365_ano: row.v365, reconstruido: rebuilt ? 1 : 0 });
    }
    if (vt.rows.length > 1000) vt.rows.splice(0, vt.rows.length - 1000);
    if (added) {
      const r = vt.rows.at(-1);
      this.log(`momentum alvo de vol: dia base ${r.base.toFixed(1)}bp × k ${r.k.toFixed(2)} = ${r.alvoLiq.toFixed(1)}bp | k de amanhã ${r.kNext.toFixed(2)} (vol 30d ${(r.v30 * 100).toFixed(0)}% / 365d ${(r.v365 * 100).toFixed(0)}% a.a.)`);
      this.save();
    }
  }

  /** chamado depois do rebalanceamento do momentum do paper (barra T) */
  onMomentum(T) {
    const M = this.momentum;
    if (M?.ready && M.st.lastT === T) { try { this.volTarget(T); } catch (e) { log('ERRO', `sombra alvo de vol: ${e.stack}`); } }
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
    for (const k of TRADE_STRATS) {
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
    const rows = this.st.tbf.map((r) => { const t = closedBy.get(`${r.inst}|${r.k}|${r.sym}`); return { ...r, rel: null, decision: t ? 'fechado' : decOf(r) ?? '–', R: t?.R_real ?? null, Rtheo: t?.R_theo_net ?? null }; });
    const grp = (key) => {
      const done = rows.filter((r) => Number.isFinite(r.R) && Number.isFinite(r[key]));
      const hi = done.filter((r) => r[key] >= RULES.fade_tbf.corte), lo = done.filter((r) => r[key] < RULES.fade_tbf.corte);
      return { nHi: hi.length, nLo: lo.length, RHi: mean(hi.map((r) => r.R)), RLo: mean(lo.map((r) => r.R)) };
    };
    // H4: lado do momentum no ativo do sinal (rel = oposto se o fade vai contra a perna do momentum)
    const relOf = (r) => { if (r.mom == null) return null; const d = r.side === 'long' ? 1 : -1; return r.mom === 0 ? 'fora' : r.mom === -d ? 'oposto' : 'mesmo'; };
    const fm = rows.filter((r) => relOf(r) && Number.isFinite(r.R));
    const gm = Object.fromEntries(['oposto', 'fora', 'mesmo'].map((k) => { const x = fm.filter((r) => relOf(r) === k); return [k, { n: x.length, R: mean(x.map((r) => r.R)), sum: sum(x.map((r) => r.R)) }]; }));
    const M = RULES.fade_mom.mult, sumBase = sum(fm.map((r) => r.R)), sumVar = sum(fm.map((r) => r.R * (relOf(r) === 'oposto' ? M : 1)));
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
        medL: mean(rows.map((r) => r.tbfL)), medB: mean(rows.map((r) => r.tbfB)), rows: rows.slice(0, 80).map((r) => ({ ...r, rel: relOf(r) })) },
      fadeMom: { ...RULES.fade_mom, n: rows.filter((r) => relOf(r)).length, closed: fm.length, g: gm, sumBase, sumVar },
      mom: { ...RULES.mom_esticado, days: md.length, base: mean(md.map((d) => d.base)), str: mean(md.map((d) => d.str)), diff: mean(md.map((d) => d.diff)),
        diffT: tstat(md.map((d) => d.diff)), sumBase: sum(md.map((d) => d.base)), sumStr: sum(md.map((d) => d.str)),
        exclDays: md.filter((d) => d.excl.length).length, daily: (mo?.daily ?? []).slice(-60).reverse() },
      cap: { ...RULES.capitulacao, hist: this.st.cap.hist.slice(-72), last: this.st.cap.last, pending: this.st.cap.pending, events: this.st.events.filter((e) => e.strat === 'capitulacao') },
      rsi: this.st.rsi, fdsRef: this.st.fdsRef ? { T: this.st.fdsRef.T, n: Object.keys(this.st.fdsRef.ref).length } : null,
      fdiff: this.fdiffView(),
      qt: this.qtView(),
      res: { ...RULES.resultado, dec: this.st.res.dec.slice(0, 60), upcoming: this.st.res.upcoming,
        today: (() => { const d = this.st.res.days[et(Date.now()).date]; return d ? { cal: d.cal ?? null, err: d.err ?? null, tries: d.tries, decided: d.decided ?? null } : null; })() },
      vt: (() => { const r = this.st.vt.rows, live = r.filter((x) => !x.rebuilt);
        return { ...RULES.mom_voltarget, days: r.length, daysLive: live.length, base: mean(r.map((x) => x.base)), alvo: mean(r.map((x) => x.alvoLiq)),
          diff: mean(r.map((x) => x.alvoLiq - x.base)), diffT: tstat(r.map((x) => x.alvoLiq - x.base)), sumBase: sum(r.map((x) => x.base)),
          sumAlvo: sum(r.map((x) => x.alvoLiq)), kNow: r.at(-1)?.kNext ?? null, kMean: mean(r.map((x) => x.k)), rows: r.slice(-60).reverse() }; })(),
      next: this.nextEvents(Date.now()),
    };
  }

  /** erro no quad em turbulencia nao derruba a aba */
  qtView() {
    try { return this.qt?.view() ?? null; } catch (e) { log('ERRO', `sombra quad view: ${e.stack}`); return null; }
  }

  /** erro no diferencial de funding nao derruba a aba */
  fdiffView() {
    try { return this.fdiff?.view() ?? null; } catch (e) { log('ERRO', `sombra fdiff view: ${e.stack}`); return null; }
  }

  nextEvents(now) {
    const n = (pred) => nextET(now, pred);
    return { overnight: n((e) => tradingDay(e) && e.hh === 16 && e.mm === 0), fdsRef: n((e) => e.wd === 5 && e.hh === 20 && e.mm === 0),
      fds: n((e) => e.wd === 0 && e.hh === 20 && e.mm === 0), momentum: this.momentum ? this.momentum.scheduledT(now) + DAY : null,
      resultado: n((e) => tradingDay(e) && e.hh === 18 && e.mm === 15) };
  }
}
