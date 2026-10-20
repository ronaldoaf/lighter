import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { log, readJSON, writeJSON, ensureDir, CsvLog } from './util.js';
import { barStats } from './fdiff.js';

const MIN = 60_000, H = 3_600_000, DAY = 86_400_000;
const PAD = 2 * H; // folga nos pedidos de funding da Lighter (a API corta o primeiro/ultimo carimbo da faixa)

/** Regra congelada (decidida com o usuario em 2026-10-15). Nao mudar depois de iniciado. */
export const COH = {
  titulo: 'Carteiras das coortes da HyperTracker',
  regra: 'às 0/6/12/18h UTC: para cada uma das 16 coortes (8 por PnL, 8 por tamanho) e cada visão (todas as posições · abertas há < 24h), ' +
    'as 10 maiores posições da coorte por valor bruto na Hyperliquid (/positions/heatmap); entra no lado líquido se a coorte tiver ≥ 55% do valor de um lado ' +
    '(viés entre 0,45 e 0,55 = neutro, fica fora); só ativos com par verificado na Lighter (hl_lighter_map.json) e livro com liquidez; peso igual ±1/n entre os que sobram ' +
    '(1× bruto). Resultado no mid do livro da Lighter na decisão, custo de varrer o livro no giro (US$10k por carteira), funding real da Lighter',
  hours: [0, 6, 12, 18], views: ['all', '24h'], top: 10, neutral: [0.45, 0.55], capital: 10_000, costMissing: 0.003,
  retryMin: 90, dayCap: 90, api: 'https://ht-api.coinmarketman.com/api/external',
};

/** ids de /segments (conferidos em 2026-10-15); ordem do painel: PnL do maior ao menor, depois tamanho do maior ao menor */
export const SEGS = [
  [8, 'Money Printer', 'pnl', '💰', '> +$1M'], [9, 'Smart Money', 'pnl', '📈', '+$100k a $1M'], [10, 'Consistent Grinder', 'pnl', '📊', '+$10k a $100k'],
  [11, 'Humble Earner', 'pnl', '🙏', '$0 a $10k'], [12, 'Exit Liquidity', 'pnl', '🤡', '−$10k a $0'], [13, 'Semi-Rekt', 'pnl', '🔥', '−$100k a −$10k'],
  [14, 'Full Rekt', 'pnl', '🚨', '−$1M a −$100k'], [15, 'Giga-Rekt', 'pnl', '💀', '< −$1M'],
  [7, 'Leviathan', 'size', '🐉', '> $5M'], [6, 'Tidal Whale', 'size', '🌊', '$1M a $5M'], [5, 'Whale', 'size', '🐳', '$500k a $1M'],
  [4, 'Small Whale', 'size', '🐋', '$100k a $500k'], [3, 'Apex Predator', 'size', '🦈', '$50k a $100k'], [2, 'Dolphin', 'size', '🐬', '$10k a $50k'],
  [1, 'Fish', 'size', '🐟', '$250 a $10k'], [16, 'Shrimp', 'size', '🦐', '$0 a $250'],
].map(([id, name, cat, emoji, faixa]) => ({ id, name, cat, emoji, faixa }));

const iso = (t) => new Date(t).toISOString();
const key = (view, seg) => `${view}:${seg}`;

/** hora de decisao mais recente <= T */
export const decisionAt = (T) => Math.floor(T / (6 * H)) * 6 * H;

/** le KEY=VALOR de um arquivo .env (sem aspas) */
export function readEnv(file) {
  const out = {};
  try {
    for (const l of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2];
    }
  } catch { /* sem arquivo */ }
  return out;
}

/** totais da coorte somando todos os ativos do heatmap */
export function totals(heat, seg) {
  let value = 0, long = 0, short = 0, count = 0, coins = 0;
  for (const r of heat) {
    const s = r.segments?.find((x) => x.segmentId === seg);
    if (!s || !(s.totalValue > 0)) continue;
    value += s.totalValue; long += s.totalLongValue; short += s.totalShortValue; count += s.count ?? 0; coins++;
  }
  return { value, long, short, bias: long + short > 0 ? long / (long + short) : null, count, coins };
}

/**
 * Top N da coorte e carteira-alvo. map: coin HL -> simbolo Lighter; bookOk(sym) diz se o livro da Lighter tem liquidez.
 * Retorna cands (as N maiores com a decisao de cada) e w (simbolo Lighter -> peso; dois coins no mesmo simbolo somam).
 */
export function pickCohort(heat, seg, map, bookOk, R = COH) {
  const rows = [];
  for (const r of heat) {
    const s = r.segments?.find((x) => x.segmentId === seg);
    if (s && s.totalValue > 0) rows.push({ coin: r.coin, value: s.totalValue, long: s.totalLongValue, short: s.totalShortValue, count: s.count });
  }
  rows.sort((a, b) => b.value - a.value || (a.coin < b.coin ? -1 : 1));
  const cands = rows.slice(0, R.top).map((x, i) => {
    const tot = x.long + x.short, bias = tot > 0 ? x.long / tot : null, lighter = map[x.coin] ?? null;
    let decision;
    if (bias === null || (bias >= R.neutral[0] && bias <= R.neutral[1])) decision = 'neutro';
    else if (!lighter) decision = 'sem par na Lighter';
    else if (!bookOk(lighter)) decision = 'sem livro';
    else decision = bias > R.neutral[1] ? 'long' : 'short';
    return { rank: i + 1, ...x, bias, lighter, decision };
  });
  const take = cands.filter((c) => c.decision === 'long' || c.decision === 'short');
  const w = {};
  for (const c of take) w[c.lighter] = (w[c.lighter] ?? 0) + (c.decision === 'long' ? 1 : -1) / take.length;
  for (const s of Object.keys(w)) if (Math.abs(w[s]) < 1e-12) delete w[s];
  for (const c of cands) c.w = take.includes(c) ? (c.decision === 'long' ? 1 : -1) / take.length : 0;
  return { cands, w, n: take.length };
}

/**
 * Carteiras-sombra das coortes da HyperTracker (sem capital): 16 coortes x 2 visoes = 32 carteiras, rebalanceadas a cada 6h.
 * A API so tem a foto atual (sem historico): decisao perdida (app parado > 90 min depois da hora) nao e refeita; a carteira
 * segue com os pesos anteriores e o periodo seguinte e medido do ultimo preco guardado ate a decisao nova.
 * P&L do periodo (decisao anterior, agora]: bruto = soma w (mid_agora / mid_antes - 1); funding = -soma w x carimbos da Lighter;
 * custo = giro x custo de varrer o livro para |dw| x US$10k, medido na decisao e cobrado no periodo que comeca nela (como o fdiff).
 * Estado em data/cohorts/state.json; periods.csv, picks.csv, cohorts.csv e as fotos cruas em raw/<dia>/<hhmm>_<visao>.json.gz.
 */
export class Cohorts {
  constructor({ dataDir, rest, recorder, bars, live, markets, mapFile = 'hl_lighter_map.json', envFile = '.env.hypertracker', fetchHeat, fetchFunding }) {
    Object.assign(this, { rest, recorder, bars, live, markets });
    this.dir = ensureDir(path.join(dataDir, 'cohorts'));
    this.file = path.join(this.dir, 'state.json');
    const m = readJSON(mapFile, null);
    if (!m?.mapa) throw new Error(`tabela HL -> Lighter ausente (${mapFile})`);
    this.map = Object.fromEntries(Object.entries(m.mapa).map(([k, v]) => [k, v.lighter]));
    this.mapInfo = { gerado: m.gerado, pares: Object.keys(this.map).length };
    this.apiKey = readEnv(envFile).HYPERTRACKER_KEY ?? null;
    if (!this.apiKey && !fetchHeat) throw new Error(`chave HYPERTRACKER_KEY ausente (${envFile})`);
    this.fetch = { heat: fetchHeat ?? ((v) => this.#heatApi(v)), funding: fetchFunding ?? ((id, a, b) => this.#fundingApi(id, a, b)) };
    this.st = readJSON(this.file, null) ?? { startedAt: Date.now(), books: {}, rows: [], last: null, calls: { day: null, n: 0 }, lastT: null, skipped: [] };
    this.rowCsv = new CsvLog(path.join(this.dir, 'periods.csv'), ['T', 'visao', 'coorte', 'inicio', 'atraso_min', 'bruto_bp', 'custo_bp', 'funding_bp', 'liq_bp',
      'giro', 'posicoes', 'sem_preco', 'sem_funding']);
    this.pickCsv = new CsvLog(path.join(this.dir, 'picks.csv'), ['T', 'visao', 'coorte', 'rank', 'coin', 'lighter', 'valor', 'comprado', 'vendido', 'vies', 'decisao', 'peso', 'preco']);
    this.cohCsv = new CsvLog(path.join(this.dir, 'cohorts.csv'), ['T', 'visao', 'coorte', 'valor', 'comprado', 'vendido', 'vies', 'posicoes', 'ativos']);
    this.busy = false; this.lastError = null; this.warnAt = 0;
  }

  save() { writeJSON(this.file, this.st); }
  log(msg) { log('COORTE', msg); }

  #fail(msg) {
    this.lastError = { at: Date.now(), msg };
    if (Date.now() - this.warnAt > H) { log('AVISO', `coortes: ${msg} (tenta de novo na próxima barra)`); this.warnAt = Date.now(); }
    return false;
  }

  /** chamado no fechamento de cada barra de 15m (T = fim da barra) */
  async onBarClose(T, now = Date.now()) {
    if (this.busy) return;
    const D = decisionAt(T);
    if (this.st.lastT !== null && this.st.lastT >= D) return;
    if (now - D > COH.retryMin * MIN) {
      if (this.st.lastT !== null && !this.st.skipped.includes(D)) { this.st.skipped.push(D); this.save(); this.log(`decisão ${iso(D).slice(0, 16)} perdida (app parado): carteiras mantidas`); }
      return;
    }
    this.busy = true;
    try { await this.#decide(D, now); } catch (e) { this.#fail(e.message); log('ERRO', `coortes: ${e.stack}`); } finally { this.busy = false; }
  }

  #budget(now, n) {
    const d = iso(now).slice(0, 10);
    if (this.st.calls.day !== d) this.st.calls = { day: d, n: 0 };
    return this.st.calls.n + n <= COH.dayCap;
  }

  /** preco do simbolo agora: mid do livro gravado; sem livro, ultimo negocio; sem nada, fechamento 15m */
  price(sym, T) {
    const t = this.recorder?.books.get(sym)?.top();
    if (t?.mid > 0) return t.mid;
    const p = this.live?.lastPx?.get(sym);
    if (p > 0) return p;
    const c = this.bars ? barStats(this.bars.load(sym), T + 1).c : NaN;
    return c > 0 ? c : NaN;
  }

  bookOk(sym) {
    if (!this.markets().some((m) => m.symbol === sym)) return false;
    const ob = this.recorder?.books.get(sym);
    return !!ob?.ready && Number.isFinite(ob.cost(1000));
  }

  #cost(sym, usd) {
    const ob = this.recorder?.books.get(sym), c = ob?.ready ? ob.cost(usd) : NaN;
    return Number.isFinite(c) ? c : COH.costMissing;
  }

  async #decide(D, now) {
    const R = COH;
    if (!this.#budget(now, R.views.length)) return this.#fail(`limite diário de ${R.dayCap} chamadas à HyperTracker atingido`);
    const heat = {};
    for (const v of R.views) {
      this.st.calls.n++; this.save();
      try { heat[v] = await this.fetch.heat(v); }
      catch (e) { return this.#fail(`heatmap ${v}: ${e.message}`); }
      if (!Array.isArray(heat[v]) || heat[v].length < 50) return this.#fail(`heatmap ${v} veio com ${heat[v]?.length ?? 0} ativos`);
    }
    for (const v of R.views) this.#saveRaw(D, v, heat[v]);

    // carteiras-alvo
    const tg = {};
    for (const v of R.views) for (const s of SEGS) tg[key(v, s.id)] = { view: v, seg: s.id, ...pickCohort(heat[v], s.id, this.map, (x) => this.bookOk(x)), tot: totals(heat[v], s.id) };

    // precos agora e funding desde a decisao anterior de cada carteira
    const syms = new Set();
    for (const b of Object.values(this.st.books)) for (const s of Object.keys(b.hold)) syms.add(s);
    for (const t of Object.values(tg)) for (const s of Object.keys(t.w)) syms.add(s);
    const px = Object.fromEntries([...syms].map((s) => [s, this.price(s, D)]));
    const held = new Set(Object.values(this.st.books).flatMap((b) => Object.keys(b.hold)));
    const froms = Object.values(this.st.books).map((b) => b.lastT).filter((x) => x !== null);
    const fund = new Map();
    if (held.size && froms.length) {
      const a = Math.min(...froms), byS = new Map(this.markets().map((m) => [m.symbol, m.market_id]));
      await Promise.all([...held].map(async (s) => {
        try { fund.set(s, byS.has(s) ? await this.fetch.funding(byS.get(s), a, D) : null); } catch { fund.set(s, null); }
      }));
    }

    const bp = (x) => x * 1e4, rows = [];
    for (const [k, t] of Object.entries(tg)) {
      let b = this.st.books[k];
      // resultado do periodo anterior
      if (b) {
        let bruto = 0, funding = 0, miss = 0, nofund = 0;
        for (const [s, w] of Object.entries(b.hold)) {
          const p1 = px[s], p0 = b.lastPx[s];
          if (p1 > 0 && p0 > 0) bruto += w * (p1 / p0 - 1); else miss++;
          const f = fund.get(s);
          if (f) { for (const [ts, r] of f) if (ts > b.lastT && ts <= D) funding -= w * r; } else nofund++;
        }
        const p = b.pend ?? { cost: 0, turn: 0 };
        const row = { T: D, k, view: t.view, seg: t.seg, from: b.lastT, late: (now - D) / MIN, bruto, custo: p.cost, funding, liq: bruto - p.cost + funding,
          giro: p.turn, npos: Object.keys(b.hold).length, miss, nofund };
        rows.push(row);
      } else b = this.st.books[k] = { view: t.view, seg: t.seg, startedAt: D, hold: {}, lastT: null, lastPx: {}, pend: null };
      // rebalanceamento: giro e custo agora, cobrados no proximo periodo
      let turn = 0, cost = 0;
      for (const s of new Set([...Object.keys(t.w), ...Object.keys(b.hold)])) {
        const dw = Math.abs((t.w[s] ?? 0) - (b.hold[s] ?? 0));
        if (!(dw > 1e-12)) continue;
        turn += dw; cost += dw * this.#cost(s, dw * R.capital);
      }
      b.hold = t.w; b.lastT = D; b.pend = { cost, turn };
      b.lastPx = Object.fromEntries(Object.keys(t.w).map((s) => [s, px[s]]).filter((x) => x[1] > 0));
    }

    // registros
    for (const r of rows) {
      this.st.rows.push(r);
      this.rowCsv.append({ T: iso(D), visao: r.view, coorte: r.seg, inicio: iso(r.from), atraso_min: r.late, bruto_bp: bp(r.bruto), custo_bp: bp(r.custo),
        funding_bp: bp(r.funding), liq_bp: bp(r.liq), giro: r.giro, posicoes: r.npos, sem_preco: r.miss, sem_funding: r.nofund });
    }
    if (this.st.rows.length > 12000) this.st.rows.splice(0, this.st.rows.length - 12000);
    for (const t of Object.values(tg)) {
      for (const c of t.cands) this.pickCsv.append({ T: iso(D), visao: t.view, coorte: t.seg, rank: c.rank, coin: c.coin, lighter: c.lighter, valor: c.value,
        comprado: c.long, vendido: c.short, vies: c.bias, decisao: c.decision, peso: c.w, preco: c.lighter ? px[c.lighter] : null });
      this.cohCsv.append({ T: iso(D), visao: t.view, coorte: t.seg, valor: t.tot.value, comprado: t.tot.long, vendido: t.tot.short, vies: t.tot.bias,
        posicoes: t.tot.count, ativos: t.tot.coins });
    }
    this.st.last = { T: D, at: now, books: Object.fromEntries(Object.entries(tg).map(([k, t]) => [k, { n: t.n, tot: t.tot,
      cands: t.cands.map((c) => ({ rank: c.rank, coin: c.coin, lighter: c.lighter, value: c.value, bias: c.bias, decision: c.decision, w: c.w })) }])) };
    this.st.lastT = D;
    this.lastError = null;
    this.save();
    const f1 = (x) => bp(x).toFixed(1);
    const sm = rows.find((r) => r.k === 'all:9');
    this.log(`decisão ${iso(D).slice(0, 16)}${now - D > 20 * MIN ? ` (atrasada ${((now - D) / MIN).toFixed(0)} min)` : ''}: 32 carteiras, ` +
      `chamadas hoje ${this.st.calls.n}/${R.dayCap} | Smart Money (todas): ${Object.entries(tg['all:9'].w).map(([s, w]) => `${s}${w > 0 ? '↑' : '↓'}`).join(' ') || 'caixa'}` +
      (sm ? ` | período anterior ${f1(sm.liq)}bp` : ''));
    return true;
  }

  #saveRaw(D, v, heat) {
    try {
      const d = ensureDir(path.join(this.dir, 'raw', iso(D).slice(0, 10)));
      fs.writeFileSync(path.join(d, `${iso(D).slice(11, 13)}${iso(D).slice(14, 16)}_${v}.json.gz`), zlib.gzipSync(JSON.stringify(heat)));
    } catch (e) { log('AVISO', `coortes: foto crua ${v}: ${e.message}`); }
  }

  /** /positions/heatmap: 302 para um JSON no S3 (o redirecionamento e seguido sem o cabecalho de autorizacao) */
  async #heatApi(view) {
    const r = await fetch(`${COH.api}/positions/heatmap?openedWithin=${view}`, { headers: { Authorization: `Bearer ${this.apiKey}` }, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    let res = r;
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      if (!loc) throw new Error(`HTTP ${r.status} sem location`);
      res = await fetch(loc, { signal: AbortSignal.timeout(60_000) });
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 429 ? ' (limite da API)' : ''}`);
    const j = await res.json();
    return j.heatmap ?? j;
  }

  /** [[carimbo ms, fracao paga pelo comprado]] da Lighter cobrindo [a, b] (mesma conversao do fdiff) */
  async #fundingApi(marketId, a, b) {
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
  view(now = Date.now()) {
    const R = COH, bp = (x) => (Number.isFinite(x) ? x * 1e4 : null);
    const byK = new Map();
    for (const r of this.st.rows) { const a = byK.get(r.k) ?? []; a.push(r); byK.set(r.k, a); }
    const last = this.st.last;
    const books = [];
    for (const v of R.views) for (const s of SEGS) {
      const k = key(v, s.id), b = this.st.books[k], rows = byK.get(k) ?? [];
      let cum = 0, bruto = 0, custo = 0, funding = 0, peak = 0, dd = 0;
      const curve = [0];
      for (const r of rows) { cum += r.liq; bruto += r.bruto; custo += r.custo; funding += r.funding; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); curve.push(cum); }
      let live = 0;
      const pos = [];
      for (const [sym, w] of Object.entries(b?.hold ?? {})) {
        const p = this.price(sym, now), p0 = b.lastPx[sym], r = p > 0 && p0 > 0 ? w * (p / p0 - 1) : NaN;
        if (Number.isFinite(r)) live += r;
        pos.push({ sym, w, r: bp(r) });
      }
      const L = last?.books?.[k];
      books.push({ k, view: v, seg: s.id, periods: rows.length, sum: bp(cum), bruto: bp(bruto), custo: bp(custo), funding: bp(funding), dd: bp(dd),
        live: bp(live), curve: curve.map((x) => x * 1e4).filter((_, i, a) => a.length <= 120 || i % Math.ceil(a.length / 120) === 0 || i === a.length - 1),
        pos: pos.sort((a, b) => b.w - a.w), n: L?.n ?? 0, tot: L?.tot ?? null, cands: L?.cands ?? [],
        rows: rows.slice(-40).reverse().map((r) => ({ T: r.T, from: r.from, late: r.late, bruto: bp(r.bruto), custo: bp(r.custo), funding: bp(r.funding), liq: bp(r.liq),
          giro: r.giro, npos: r.npos, miss: r.miss })) });
    }
    const next = decisionAt(now) + 6 * H;
    return { rule: R, segs: SEGS, map: this.mapInfo, startedAt: this.st.startedAt, lastT: this.st.lastT, lastAt: last?.at ?? null, next,
      calls: this.st.calls, error: this.lastError, skipped: this.st.skipped.slice(-10), books };
  }
}
