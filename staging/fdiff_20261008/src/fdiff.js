import path from 'node:path';
import { log, readJSON, writeJSON, ensureDir, CsvLog } from './util.js';

const MIN = 60_000, H = 3_600_000, DAY = 86_400_000;
const BAPI = 'https://fapi.binance.com/fapi/v1';
const WAIT_MIN = 30;  // espera o carimbo de funding da hora da decisao por ate 30 min
const INIT_MIN = 60;  // carteira nova so comeca numa decisao ao vivo (ate 60 min depois da hora)
const KEEP_D = 16;    // dias de funding guardados em memoria
const PAD = 2 * H;    // folga nas pontas dos pedidos de funding da Lighter (a API corta o primeiro/ultimo carimbo da faixa)

/** Regra congelada (TREND.md 17.8; backtest scripts/study_fdiff_final.py). Nao mudar depois de iniciado. */
export const FDIFF = {
  titulo: 'Diferencial de funding Lighter − Binance', secao: 'TREND 17.8',
  regra: 'às 0/6/12/18h UTC (4 carteiras de ¼ do capital): fd7 = funding pago na Lighter nas últimas 168h − funding pago na Binance no mesmo ativo; ' +
    'compra o decil de maior fd7 e vende o de menor (±0,5/n); carteira = média das 7 últimas tranches da mesma hora. Universo: cripto com perp USDT na Binance, ' +
    'vol 24h ≥ US$500k, negócio na última hora, ≥ 14 dias de preço. Teórico a 1× bruto: fechamentos de 15m, custo do livro (US$5k) no giro, funding da Lighter',
  hours: [0, 6, 12, 18], winH: 168, q: 0.1, hold: 7, liq: 5e5, minAgeD: 14, costUSD: 5000, costMissing: 0.003,
  esperado: { liq: 27, bruto: 35, custo: -3.6, funding: -4.4, sharpe: 3.28, sharpeCego: 1.36 }, // bp/dia e Sharpe do backtest (Lighter) e da validacao cega
};

/** perp USDT da Binance para o simbolo da Lighter (mesma ordem de scripts/fdiff_common.binance_name) */
export function binanceName(x, names) {
  for (const c of [x + 'USDT', '1000' + x + 'USDT', x.replaceAll('1000', '') + 'USDT', x.replaceAll('1000', '1000000') + 'USDT']) if (names.has(c)) return c;
  return null;
}

/** no instante T, pelos candles 15m ordenados: ultimo fechamento antes de T (ffill), volume das 24h e se houve negocio na ultima hora */
export function barStats(bars, T) {
  let c = NaN, vol24 = 0, alive = false;
  for (let i = bars.length - 1; i >= 0; i--) {
    const x = bars[i];
    if (x.t >= T) continue;
    if (Number.isNaN(c)) c = x.c;
    if (x.t < T - DAY) break;
    if (x.V > 0) vol24 += x.V;
    if (x.t >= T - H) alive = true;
  }
  return { c, vol24, alive };
}

/** funding da Lighter nos carimbos (a, b]: o carimbo da hora cheia T fecha a hora que termina em T */
export function sumL(recs, a, b) {
  let s = 0;
  for (const [t, f] of recs) if (t > a && t <= b) s += f;
  return s;
}

/** funding da Binance com a hora do carimbo em [a, b) */
export function sumB(recs, a, b) {
  let s = 0;
  for (const [t, f] of recs) { const h = Math.floor(t / H) * H; if (h >= a && h < b) s += f; }
  return s;
}

/** tranche: +0,5/n nos n de maior sinal e -0,5/n nos n de menor, n = 10% do universo (empate: ordem alfabetica, a do painel) */
export function pick(univ, q = FDIFF.q) {
  const u = [...univ].sort((a, b) => (a.sym < b.sym ? -1 : a.sym > b.sym ? 1 : 0));
  const n = Math.floor(u.length * q), w = {};
  let long = [], short = [];
  if (n >= 1 && u.length >= 2 * n) {
    const o = u.map((x, i) => [x, i]).sort((a, b) => a[0].s - b[0].s || a[1] - b[1]).map((x) => x[0].sym);
    short = o.slice(0, n); long = o.slice(-n).reverse();
    for (const s of long) w[s] = 0.5 / n;
    for (const s of short) w[s] = -0.5 / n;
  }
  return { n, long, short, w };
}

/** carteira = media das tranches guardadas (rolling(H, min_periods=1).mean() do backtest) */
export function avgHold(targets) {
  const h = {};
  for (const t of targets) for (const [s, w] of Object.entries(t.w)) h[s] = (h[s] ?? 0) + w / targets.length;
  return h;
}

const iso = (t) => new Date(t).toISOString();

async function getJSON(url, ms = 15000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function namesApi() {
  const info = await getJSON(`${BAPI}/exchangeInfo`, 20000);
  return new Set(info.symbols.filter((s) => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING').map((s) => s.symbol));
}

/** [[fundingTime ms, taxa]] da Binance a partir de `from` (ate `to`, se dado) */
async function binanceApi(sym, from, to) {
  const out = [];
  for (let a = from, k = 0; k < 10; k++) {
    const xs = await getJSON(`${BAPI}/fundingRate?symbol=${sym}&startTime=${a}${to ? `&endTime=${to}` : ''}&limit=1000`);
    for (const x of xs) out.push([+x.fundingTime, +x.fundingRate]);
    if (xs.length < 1000) break;
    a = +xs.at(-1).fundingTime + 1;
  }
  return out;
}

async function pool(items, n, fn) {
  const q = [...items];
  await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => { while (q.length) await fn(q.shift()); }));
}

/**
 * Diferencial de funding em modo sombra: 4 carteiras escalonadas (0/6/12/18h UTC), cada uma com 1/4 do capital, teoricas a 1x bruto.
 * Decisao na hora cheia T, depois da atualizacao dos candles 15m da barra que termina em T (o backtest decide no fechamento da barra 1h):
 *   universo  cripto, perp USDT na Binance (exchangeInfo, TRADING), vol 24h >= 500k e negocio na ultima hora (candles 15m do fade),
 *             >= 14 dias desde o primeiro candle 1h (candles da tendencia)
 *   sinal     fd7 = funding da Lighter nos carimbos (T-168h, T] - funding da Binance com hora em [T-168h, T); a Binance precisa de
 *             historico desde T-169h (perp listado ha mais de 7 dias). Lighter: |rate| x lado (REST fundings); Binance: fapi fundingRate
 *   tranche   pick(); carteira = media das 7 ultimas tranches da mesma hora
 *   P&L       da decisao anterior ate T: bruto = soma w (C_T / C_ant - 1) nos fechamentos 15m; funding = -soma w x carimbos (ant, T];
 *             custo = giro x custo do livro para US$5k (sem livro: 30bp), medido na decisao e cobrado no periodo seguinte (como o backtest)
 * Na primeira decisao de cada carteira, as 7 tranches anteriores sao reconstruidas com os dados de cada dia (carteira ja em regime).
 * Decisoes perdidas com o app parado sao processadas depois, em ordem, so com os dados ate cada instante.
 * Estado em data/shadow/fdiff/state.json; rows.csv (uma linha por carteira e periodo) e signals.csv (sinal de cada ativo do universo).
 */
export class FundingDiff {
  constructor({ dataDir, rest, bars, trend, recorder, live, classOf, markets, fetchers = {} }) {
    Object.assign(this, { rest, bars, trend, recorder, live, classOf, markets });
    this.dir = ensureDir(path.join(dataDir, 'shadow', 'fdiff'));
    this.file = path.join(this.dir, 'state.json');
    this.st = readJSON(this.file, null) ?? { startedAt: Date.now(), books: {}, rows: [], last: null };
    this.rowCsv = new CsvLog(path.join(this.dir, 'rows.csv'), ['T', 'carteira', 'inicio', 'atraso_min', 'bruto_bp', 'custo_bp', 'custo1k_bp',
      'funding_bp', 'liq_bp', 'liq1k_bp', 'giro', 'posicoes', 'sem_preco', 'universo', 'n', 'compra', 'vende']);
    this.sigCsv = new CsvLog(path.join(this.dir, 'signals.csv'), ['T', 'carteira', 'sym', 'binance', 'f_lighter', 'f_binance', 'fd7', 'lado',
      'vol24', 'preco', 'carimbos_lighter']);
    this.fl = new Map(); // sym -> {from, to, recs: Map(carimbo ms -> fracao), err}
    this.fb = new Map(); // simbolo Binance -> {from, last, first, recs: Map(fundingTime ms -> taxa), err}
    this.fetch = { lighter: fetchers.lighter ?? ((id, a, b) => this.#lighterApi(id, a, b)), binance: fetchers.binance ?? binanceApi, names: fetchers.names ?? namesApi };
    this.names = null; this.namesAt = 0;
    this.busy = false; this.warnAt = 0; this.waiting = null; this.lastError = null;
  }

  save() { writeJSON(this.file, this.st); }
  log(msg) { log('SOMBRA', `fdiff: ${msg}`); }

  /** horarios da carteira das h UTC em (a, b] */
  static times(h, a, b) {
    const out = [];
    for (let t = Math.floor((a - h * H) / DAY) * DAY + h * H; t <= b; t += DAY) if (t > a) out.push(t);
    return out;
  }

  /** chamado no fechamento de cada barra de 15m (T = fim da barra), depois da atualizacao dos candles */
  async onBarClose(T, now = Date.now()) {
    if (this.busy) return;
    this.busy = true;
    try {
      const due = [];
      for (const h of FDIFF.hours) {
        const b = this.st.books[h];
        if (b && T - b.lastT > 8 * DAY) { this.log(`carteira ${h}h parada desde ${iso(b.lastT).slice(0, 16)} (além dos candles guardados): recomeça`); delete this.st.books[h]; }
        if (this.st.books[h]) for (const t of FundingDiff.times(h, this.st.books[h].lastT, T)) due.push({ h, T: t });
        else { const t = FundingDiff.times(h, T - DAY, T)[0]; if (t !== undefined && now - t <= INIT_MIN * MIN) due.push({ h, T: t, init: true }); }
      }
      due.sort((a, b) => a.T - b.T);
      for (const d of due) if (!(await this.#decide(d, now))) break; // dados incompletos: tenta de novo na proxima barra, na mesma ordem
    } catch (e) { log('ERRO', `sombra fdiff: ${e.stack}`); } finally { this.busy = false; }
  }

  #fail(msg) {
    this.lastError = { at: Date.now(), msg };
    if (Date.now() - this.warnAt > H) { log('AVISO', `sombra fdiff: ${msg} (tenta de novo na próxima barra)`); this.warnAt = Date.now(); }
    return false;
  }

  /** pre-universo no instante t (so candles): cripto com perp na Binance, vol 24h, negocio na ultima hora e idade */
  #pre(t, crypto, names) {
    const out = [];
    for (const m of crypto) {
      const bsym = binanceName(m.symbol, names);
      if (!bsym) continue;
      const st = barStats(this.bars.load(m.symbol), t);
      if (!(st.vol24 >= FDIFF.liq) || !st.alive) continue;
      const hb = this.trend.load(m.symbol);
      if (!hb.length || (t - H - hb[0].t) / DAY < FDIFF.minAgeD) continue;
      out.push({ sym: m.symbol, mid: m.market_id, bsym, c: st.c, vol24: st.vol24 });
    }
    return out;
  }

  /** universo com o sinal no instante t (sai quem nao tem funding das duas bolsas ou tem menos de 7 dias de perp na Binance) */
  #signal(t, pre) {
    const R = FDIFF, a = t - R.winH * H, out = [];
    for (const x of pre) {
      const L = this.fl.get(x.sym), B = this.fb.get(x.bsym);
      if (!L || L.err || !B || B.err || B.first === null || B.first > t - (R.winH + 1) * H) continue;
      let nl = 0;
      for (const k of L.recs.keys()) if (k > a && k <= t) nl++;
      const fl = sumL(L.recs, a, t), fb = sumB(B.recs, a, t);
      out.push({ ...x, fl, fb, s: fl - fb, nl });
    }
    return out;
  }

  /** universo, sinal e tranche no instante T, sem mexer nas carteiras (paridade com o backtest: test/fdiff_parity.test.js) */
  async snapshot(T, now = Date.now()) {
    const names = await this.#names();
    const pre = this.#pre(T, this.markets().filter((m) => this.classOf(m.symbol) === 'cripto'), names);
    await this.#ensure(pre, T - (FDIFF.winH + 24) * H, T, now);
    const univ = this.#signal(T, pre);
    return { univ, ...pick(univ) };
  }

  async #decide({ h, T, init }, now) {
    const R = FDIFF;
    let names;
    try { names = await this.#names(); } catch (e) { return this.#fail(`exchangeInfo da Binance: ${e.message}`); }
    const all = this.markets(), crypto = all.filter((m) => this.classOf(m.symbol) === 'cripto');
    const times = init ? Array.from({ length: R.hold + 1 }, (_, i) => T - (R.hold - i) * DAY) : [T];
    const pre = times.map((t) => this.#pre(t, crypto, names));
    const need = new Map();
    for (const p of pre) for (const x of p) need.set(x.sym, x);
    for (const s of Object.keys(this.st.books[h]?.hold ?? {})) {
      const m = all.find((x) => x.symbol === s);
      if (m && !need.has(s)) need.set(s, { sym: s, mid: m.market_id, bsym: null });
    }
    await this.#ensure([...need.values()], times[0] - (R.winH + 24) * H, T, now);
    const cur = pre.at(-1);
    const bad = cur.filter((x) => this.fl.get(x.sym)?.err || this.fb.get(x.bsym)?.err);
    if (!cur.length || bad.length > 0.2 * cur.length) {
      return this.#fail(cur.length ? `funding indisponível em ${bad.length} de ${cur.length} ativos (${bad.slice(0, 3).map((x) => `${x.sym}: ${this.fl.get(x.sym)?.err ?? this.fb.get(x.bsym)?.err}`).join('; ')})`
        : 'universo vazio (candles ou lista da Binance)');
    }
    const withT = [...need.values()].filter((x) => this.fl.get(x.sym)?.recs.has(T)).length;
    if (withT < 0.8 * need.size && now - T < WAIT_MIN * MIN) { this.waiting = { T, h, have: withT, need: need.size, at: now }; return false; }
    this.waiting = null;

    const tgs = times.map((t, i) => { const univ = this.#signal(t, pre[i]); return { t, univ, ...pick(univ) }; });
    const tg = tgs.at(-1);
    if (init) {
      const prev = tgs.slice(0, -1).map((x) => ({ T: x.t, w: x.w }));
      this.st.books[h] = { h, startedAt: T, targets: prev, hold: avgHold(prev), lastT: null, lastC: {}, pend: null };
    }
    const b = this.st.books[h];

    // resultado do periodo (decisao anterior, T] com a carteira em vigor
    let row = null;
    if (!init) {
      let bruto = 0, funding = 0, miss = 0;
      for (const [s, w] of Object.entries(b.hold)) {
        const c1 = barStats(this.bars.load(s), T).c, c0 = b.lastC[s];
        if (c1 > 0 && c0 > 0) bruto += w * (c1 / c0 - 1); else miss++;
        const L = this.fl.get(s);
        if (L && !L.err) funding -= w * sumL(L.recs, b.lastT, T);
      }
      const p = b.pend ?? { cost: 0, cost1k: 0, turn: 0 };
      row = { T, h, from: b.lastT, late: (now - T) / MIN, bruto, custo: p.cost, custo1k: p.cost1k, funding, liq: bruto - p.cost + funding,
        liq1k: bruto - p.cost1k + funding, giro: p.turn, npos: Object.keys(b.hold).length, miss, univ: tg.univ.length, n: tg.n, long: tg.long, short: tg.short };
    }

    // nova tranche; giro e custo medidos agora, cobrados no proximo periodo
    b.targets = b.targets.filter((x) => x.T < T).concat([{ T, w: tg.w }]).slice(-R.hold);
    const hold = avgHold(b.targets);
    let turn = 0, cost = 0, cost1k = 0;
    for (const s of new Set([...Object.keys(hold), ...Object.keys(b.hold)])) {
      const dw = Math.abs((hold[s] ?? 0) - (b.hold[s] ?? 0));
      if (!(dw > 1e-12)) continue;
      const ob = this.recorder.books.get(s), c5 = ob?.ready ? ob.cost(R.costUSD) : NaN, c1 = ob?.ready ? ob.cost(1000) : NaN;
      turn += dw; cost += dw * (Number.isFinite(c5) ? c5 : R.costMissing); cost1k += dw * (Number.isFinite(c1) ? c1 : R.costMissing);
    }
    b.hold = hold; b.lastT = T; b.pend = { cost, cost1k, turn };
    b.lastC = Object.fromEntries(Object.keys(hold).map((s) => [s, barStats(this.bars.load(s), T).c]).filter((x) => x[1] > 0));

    // registros
    const bp = (x) => x * 1e4;
    if (row) {
      this.st.rows.push(row);
      if (this.st.rows.length > 3000) this.st.rows.splice(0, this.st.rows.length - 3000);
      this.rowCsv.append({ T: iso(T), carteira: h, inicio: iso(row.from), atraso_min: row.late, bruto_bp: bp(row.bruto), custo_bp: bp(row.custo),
        custo1k_bp: bp(row.custo1k), funding_bp: bp(row.funding), liq_bp: bp(row.liq), liq1k_bp: bp(row.liq1k), giro: row.giro, posicoes: row.npos,
        sem_preco: row.miss, universo: row.univ, n: row.n, compra: row.long.join(' '), vende: row.short.join(' ') });
    }
    const side = (s) => (tg.w[s] > 0 ? 'long' : tg.w[s] < 0 ? 'short' : '');
    const univ = [...tg.univ].sort((x, y) => y.s - x.s);
    for (const u of univ) this.sigCsv.append({ T: iso(T), carteira: h, sym: u.sym, binance: u.bsym, f_lighter: u.fl, f_binance: u.fb, fd7: u.s,
      lado: side(u.sym), vol24: u.vol24, preco: u.c, carimbos_lighter: u.nl });
    this.st.last = { T, h, at: now, init: !!init, n: tg.n, long: tg.long, short: tg.short, turn, cost,
      univ: univ.map((u) => ({ sym: u.sym, fl: u.fl, fb: u.fb, s: u.s, nl: u.nl, side: side(u.sym) })) };
    this.save();
    const f1 = (x) => bp(x).toFixed(1);
    this.log(`${init ? 'início da carteira' : 'decisão'} ${h}h ${iso(T).slice(0, 16)}${now - T > 20 * MIN ? ` (atrasada ${((now - T) / MIN).toFixed(0)} min)` : ''}: ` +
      `universo ${tg.univ.length}, n ${tg.n} | compra ${tg.long.join(',') || '-'} | vende ${tg.short.join(',') || '-'}` +
      (row ? ` | período anterior: bruto ${f1(row.bruto)}bp, custo ${f1(-row.custo)}, funding ${f1(row.funding)} → ${f1(row.liq)}bp` : ` | giro ${turn.toFixed(2)}, custo ${f1(cost)}bp`) +
      (withT < need.size ? ` | carimbo ${iso(T).slice(11, 16)} da Lighter em ${withT}/${need.size}` : ''));
    return true;
  }

  // ---------------------------------------------------------------- funding (memoria + APIs)
  async #names() {
    if (!this.names || Date.now() - this.namesAt > 6 * H) {
      try { this.names = await this.fetch.names(); this.namesAt = Date.now(); }
      catch (e) { if (!this.names) throw e; } // falhou: segue com a lista anterior
    }
    return this.names;
  }

  /** completa o funding em memoria: Lighter de A ate T, Binance de A ate agora */
  async #ensure(list, A, T, now) {
    const cut = now - KEEP_D * DAY;
    const lighter = Promise.all(list.map(async (x) => {
      let c = this.fl.get(x.sym);
      if (!c) this.fl.set(x.sym, (c = { from: A, to: -Infinity, recs: new Map(), err: null }));
      try {
        const parts = [];
        if (!c.recs.size) parts.push([Math.min(A, c.from), T]);
        else { if (A < c.from) parts.push([A, c.from]); if (c.to < T) parts.push([c.to, T]); }
        for (const [a, b] of parts) for (const [t, f] of await this.fetch.lighter(x.mid, a, b)) c.recs.set(t, f);
        c.from = Math.min(c.from, A); c.err = null;
        for (const t of c.recs.keys()) { if (t < cut) c.recs.delete(t); else if (t > c.to) c.to = t; }
        c.from = Math.max(c.from, cut);
      } catch (e) { c.err = e.message; }
    }));
    const binance = pool([...new Set(list.map((x) => x.bsym).filter(Boolean))], 4, async (s) => {
      let c = this.fb.get(s);
      if (!c) this.fb.set(s, (c = { from: A, last: null, first: null, recs: new Map(), err: null }));
      try {
        const got = [];
        if (c.last === null) got.push(...await this.fetch.binance(s, Math.min(A, c.from)));
        else {
          if (A < c.from) got.push(...await this.fetch.binance(s, A, c.from - 1));
          if (c.last < T - H) got.push(...await this.fetch.binance(s, c.last + 1)); // a janela usa os carimbos antes de T
        }
        for (const [t, r] of got) c.recs.set(t, r);
        c.from = Math.min(c.from, A); c.err = null;
        c.last = -Infinity; c.first = null;
        for (const t of c.recs.keys()) {
          if (t < cut) { c.recs.delete(t); continue; }
          c.last = Math.max(c.last, t);
          const hr = Math.floor(t / H) * H;
          if (c.first === null || hr < c.first) c.first = hr;
        }
        if (c.last === -Infinity) c.last = A; // sem carimbo nenhum: proxima vez pede so o que vier depois
        c.from = Math.max(c.from, cut);
      } catch (e) { c.err = e.message; }
    });
    await Promise.all([lighter, binance]);
  }

  /** [[carimbo ms, fracao paga pelo comprado]] da Lighter cobrindo [a, b] (|rate| x lado; rate em % por hora) */
  async #lighterApi(marketId, a, b) {
    const out = [];
    for (let s = a; s <= b; s += 400 * H) {
      const e = Math.min(b, s + 400 * H);
      const r = await this.rest.get('fundings', { market_id: marketId, resolution: '1h', start_timestamp: Math.floor((s - PAD) / 1000),
        end_timestamp: Math.ceil((e + PAD) / 1000), count_back: 0 });
      for (const x of r?.fundings ?? []) out.push([x.timestamp * 1000, Math.abs(+x.rate) / 100 * (x.direction === 'long' ? 1 : -1)]);
    }
    return out;
  }

  // ---------------------------------------------------------------- dashboard
  mid(sym) {
    const t = this.recorder.books.get(sym)?.top();
    return t?.mid ?? this.live?.lastPx?.get(sym) ?? NaN;
  }

  /** valores em bp; por dia = soma das 4 carteiras / 4 (cada uma tem 1/4 do capital) */
  view(now = Date.now()) {
    const R = FDIFF, rows = this.st.rows, bp = (x) => (Number.isFinite(x) ? x * 1e4 : null);
    const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
    const byDay = new Map();
    for (const r of rows) {
      const d = iso(r.T).slice(0, 10), x = byDay.get(d) ?? { d, liq: 0, liq1k: 0, bruto: 0, custo: 0, funding: 0, n: 0 };
      x.liq += r.liq / 4; x.liq1k += r.liq1k / 4; x.bruto += r.bruto / 4; x.custo += r.custo / 4; x.funding += r.funding / 4; x.n++;
      byDay.set(d, x);
    }
    const days = [...byDay.values()], L = days.map((x) => x.liq), m = mean(L), s = sd(L);
    let cum = 0, peak = 0, dd = 0;
    const curve = rows.map((r) => { cum += r.liq / 4; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); return { t: r.T, y: cum * 1e4 }; });
    const pos = {};
    let live = 0;
    for (const b of Object.values(this.st.books)) {
      for (const [sym, w] of Object.entries(b.hold)) {
        const p = (pos[sym] ??= { sym, w: 0, r: 0, books: 0 }), mid = this.mid(sym), c0 = b.lastC[sym];
        p.w += w / 4; p.books++;
        if (mid > 0 && c0 > 0) { const x = w / 4 * (mid / c0 - 1); p.r += x; live += x; }
      }
    }
    const next = Math.min(...R.hours.map((h) => FundingDiff.times(h, now, now + DAY)[0]));
    return {
      rule: R, startedAt: this.st.startedAt, next, waiting: this.waiting, error: this.lastError,
      books: Object.values(this.st.books).map((b) => ({ h: b.h, startedAt: b.startedAt, lastT: b.lastT, npos: Object.keys(b.hold).length,
        gross: Object.values(b.hold).reduce((a, w) => a + Math.abs(w), 0) })).sort((a, b) => a.h - b.h),
      days: days.length, periods: rows.length, mean: bp(m), sd: bp(s), t: s > 0 ? m / (s / Math.sqrt(L.length)) : null,
      sharpe: s > 0 && L.length >= 20 ? m / s * Math.sqrt(365) : null, sum: bp(cum), dd: bp(dd), live: bp(live),
      bruto: bp(mean(days.map((x) => x.bruto))), custo: bp(mean(days.map((x) => x.custo))), funding: bp(mean(days.map((x) => x.funding))),
      liq1k: bp(mean(days.map((x) => x.liq1k))),
      pos: Object.values(pos).map((p) => ({ ...p, r: bp(p.r) })).sort((a, b) => b.w - a.w),
      last: this.st.last, curve: curve.length > 1500 ? curve.filter((_, i) => i % Math.ceil(curve.length / 1500) === 0 || i === curve.length - 1) : curve,
      daily: days.slice(-60).reverse().map((x) => ({ d: x.d, n: x.n, liq: bp(x.liq), bruto: bp(x.bruto), custo: bp(x.custo), funding: bp(x.funding) })),
      rows: rows.slice(-80).reverse().map((r) => ({ T: r.T, h: r.h, from: r.from, late: r.late, bruto: bp(r.bruto), custo: bp(r.custo), funding: bp(r.funding),
        liq: bp(r.liq), giro: r.giro, npos: r.npos, miss: r.miss, univ: r.univ, n: r.n, long: r.long, short: r.short })),
    };
  }
}
