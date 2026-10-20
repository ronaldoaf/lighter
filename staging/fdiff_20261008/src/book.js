/** Livro de ofertas local mantido por snapshot + deltas do canal order_book da Lighter. */
export class OrderBook {
  constructor(sym) {
    this.sym = sym;
    this.reset();
  }

  reset() {
    this.asks = new Map(); this.bids = new Map();
    this.nonce = null; this.ready = false; this.updatedAt = 0;
    this._sorted = null; this.gaps = this.gaps || 0;
  }

  /** aplica mensagem do WS; retorna false se houve quebra de continuidade (precisa reinscrever) */
  apply(m) {
    const ob = m.order_book;
    if (!ob) return true;
    const snapshot = m.type === 'subscribed/order_book';
    if (snapshot) {
      this.asks.clear(); this.bids.clear(); this.ready = true;
    } else {
      if (!this.ready) return true; // deltas antes do snapshot: ignora
      if (this.nonce !== null && ob.begin_nonce !== this.nonce) {
        this.gaps++; this.reset();
        return false;
      }
    }
    for (const x of ob.asks || []) set(this.asks, +x.price, +x.size);
    for (const x of ob.bids || []) set(this.bids, +x.price, +x.size);
    this.nonce = ob.nonce;
    this.updatedAt = m.timestamp || Date.now();
    this._sorted = null;
    return true;
  }

  sorted() {
    if (!this._sorted) {
      const a = [...this.asks].sort((x, y) => x[0] - y[0]);
      const b = [...this.bids].sort((x, y) => y[0] - x[0]);
      // livro cruzado momentaneo (delta parcial): descarta niveis que cruzam
      while (a.length && b.length && a[0][0] <= b[0][0]) {
        if (a[0][1] < b[0][1]) a.shift(); else b.shift();
      }
      this._sorted = { a, b };
    }
    return this._sorted;
  }

  top() {
    const { a, b } = this.sorted();
    if (!a.length || !b.length) return null;
    return { bid: b[0][0], ask: a[0][0], mid: (a[0][0] + b[0][0]) / 2 };
  }

  /** executa US$ usd a mercado: side 'buy' varre os asks, 'sell' varre os bids. */
  sweep(side, usd) {
    const { a, b } = this.sorted();
    const levels = side === 'buy' ? a : b;
    let got = 0, qty = 0;
    for (const [px, q] of levels) {
      const take = Math.min(q * px, usd - got);
      got += take; qty += take / px;
      if (got >= usd - 1e-9) return { avg: got / qty, qty, complete: true };
    }
    return { avg: qty ? got / qty : NaN, qty, complete: false };
  }

  /** executa qty unidades do ativo a mercado (para zerar uma posicao) */
  sweepQty(side, qty) {
    const { a, b } = this.sorted();
    const levels = side === 'buy' ? a : b;
    let got = 0, usd = 0;
    for (const [px, q] of levels) {
      const take = Math.min(q, qty - got);
      got += take; usd += take * px;
      if (got >= qty - 1e-12) return { avg: usd / got, qty: got, complete: true };
    }
    return { avg: got ? usd / got : NaN, qty: got, complete: false };
  }

  /** custo por perna vs preco medio (meio spread + slippage), media de compra e venda (= measure_spreads.py) */
  cost(usd) {
    const t = this.top();
    if (!t) return NaN;
    const pb = this.sweep('buy', usd), ps = this.sweep('sell', usd);
    if (!pb.complete || !ps.complete) return NaN;
    return ((pb.avg - t.mid) + (t.mid - ps.avg)) / 2 / t.mid;
  }

  /** custo de UMA perna num lado especifico (ex.: entrar vendido = 'sell') */
  sideCost(side, usd) {
    const t = this.top();
    if (!t) return NaN;
    const s = this.sweep(side, usd);
    if (!s.complete) return NaN;
    return Math.abs(s.avg - t.mid) / t.mid;
  }

  depth(pct) {
    const t = this.top();
    if (!t) return { bid: NaN, ask: NaN };
    const { a, b } = this.sorted();
    let ask = 0, bid = 0;
    for (const [px, q] of a) { if (px > t.mid * (1 + pct)) break; ask += px * q; }
    for (const [px, q] of b) { if (px < t.mid * (1 - pct)) break; bid += px * q; }
    return { bid, ask };
  }

  levels(n) {
    const { a, b } = this.sorted();
    return { a: a.slice(0, n), b: b.slice(0, n) };
  }
}

function set(map, px, q) {
  if (q > 0) map.set(px, q); else map.delete(px);
}
