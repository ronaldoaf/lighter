import { sleep, BAR } from './util.js';

/** Cliente REST da Lighter com fila de concorrencia limitada e backoff em 429/405/erros. */
export class Rest {
  constructor(base, { concurrency = 3, minGapMs = 120 } = {}) {
    this.base = base; this.concurrency = concurrency; this.minGapMs = minGapMs;
    this.active = 0; this.queue = []; this.last = 0; this.calls = 0; this.errors = 0;
  }

  async get(path, params = {}) {
    await this.#slot();
    try {
      const qs = new URLSearchParams(params).toString();
      const url = `${this.base}/${path}${qs ? '?' + qs : ''}`;
      for (let k = 0; k < 8; k++) {
        try {
          const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
          this.calls++;
          // 429, e 405 sob carga (a API devolve 405 transitorio quando limita; a mesma chamada passa depois)
          if (r.status === 429 || r.status === 405) { await sleep(3000 * (k + 1)); continue; }
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return await r.json();
        } catch (e) {
          this.errors++;
          if (k === 7) throw new Error(`${path} ${JSON.stringify(params)}: ${e.message}`);
          await sleep(1000 * (k + 1));
        }
      }
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }

  async #slot() {
    if (this.active >= this.concurrency) await new Promise((r) => this.queue.push(r));
    this.active++;
    const wait = this.last + this.minGapMs - Date.now();
    this.last = Math.max(Date.now(), this.last + this.minGapMs);
    if (wait > 0) await sleep(wait);
  }

  /** mercados perp ativos: [{symbol, market_id, ...}] */
  async markets() {
    const r = await this.get('orderBooks');
    return r.order_books.filter((o) => o.market_type === 'perp' && o.status === 'active');
  }

  async tokenlist() {
    return (await this.get('tokenlist')).tokens.filter((t) => t.market === 'PERPS');
  }

  /** candles 15m fechados em [from, to) -> [{t,o,h,l,c,V}] (V = volume em USD) */
  async candles(marketId, from, to) {
    const out = [];
    let t = from;
    while (to - t >= BAR) {
      const end = Math.min(to, t + BAR * 499);
      const r = await this.get('candles', { market_id: marketId, resolution: '15m', start_timestamp: t, end_timestamp: end, count_back: 0 });
      const c = r.c || [];
      for (const x of c) if (x.t >= from && x.t + BAR <= to) out.push({ t: x.t, o: +x.o, h: +x.h, l: +x.l, c: +x.c, V: +x.V });
      t = c.length ? Math.max(...c.map((x) => x.t)) + BAR : end;
      if (!c.length && end >= to) break;
    }
    return out;
  }
}

export function classify(token) {
  // mesma regra de scripts/report_asset_class.py (tokenlist oficial)
  if (!token || token.asset_type !== 'RWA') return 'cripto'; // 1000PEPE etc. nao aparecem na lista -> cripto
  const c = new Set(token.categories || []);
  if (c.has('PRE_IPO')) return 'pre_ipo';
  if (c.has('ETF')) return 'etf_indice';
  if (c.has('FX')) return 'forex';
  if (c.has('COMMODITIES') || c.has('COMPUTE')) return 'commodities';
  return 'acoes';
}
