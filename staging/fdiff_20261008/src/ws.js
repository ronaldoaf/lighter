import { log, sleep } from './util.js';

/**
 * Pool de conexoes WebSocket da Lighter.
 * Limites (por IP): 500 inscricoes por conexao, 200 mensagens enviadas por minuto -> inscricoes vao numa fila
 * com ritmo de ~2,5/s. Ping a cada 50s (servidor desconecta sem trafego por 2 min). Reconexao reinscreve tudo.
 */
export class WsPool {
  constructor(url, { connections = 2, onMessage, onReset }) {
    this.url = url; this.onMessage = onMessage; this.onReset = onReset;
    this.conns = Array.from({ length: connections }, (_, i) => ({ i, ws: null, channels: new Set(), open: false, msgs: 0, reconnects: 0 }));
    this.where = new Map(); // canal -> conexao
    this.queue = []; this.sent = 0; this.msgCount = 0; this.rate = 0;
    this.closed = false;
  }

  start() {
    for (const c of this.conns) this.#connect(c);
    this.#pump();
    this.pingTimer = setInterval(() => {
      for (const c of this.conns) if (c.open) this.#send(c, { type: 'ping' });
    }, 50_000);
    this.rateTimer = setInterval(() => { this.rate = this.msgCount / 5; this.msgCount = 0; }, 5000);
  }

  stop() {
    this.closed = true;
    clearInterval(this.pingTimer); clearInterval(this.rateTimer);
    for (const c of this.conns) c.ws?.close();
  }

  subscribe(channel) {
    if (this.where.has(channel)) return;
    const c = this.conns.reduce((a, b) => (b.channels.size < a.channels.size ? b : a));
    c.channels.add(channel); this.where.set(channel, c);
    this.queue.push({ c, msg: { type: 'subscribe', channel } });
  }

  unsubscribe(channel) {
    const c = this.where.get(channel);
    if (!c) return;
    c.channels.delete(channel); this.where.delete(channel);
    this.queue.push({ c, msg: { type: 'unsubscribe', channel } });
  }

  /** reinscreve um canal (ex.: livro com nonce quebrado -> novo snapshot) */
  resubscribe(channel) {
    const c = this.where.get(channel);
    if (!c) return;
    this.queue.push({ c, msg: { type: 'unsubscribe', channel } }, { c, msg: { type: 'subscribe', channel } });
  }

  status() {
    return {
      conexoes: this.conns.map((c) => ({ aberta: c.open, canais: c.channels.size, reconexoes: c.reconnects })),
      fila: this.queue.length, msgsPorSeg: this.rate,
    };
  }

  #send(c, msg) {
    try { c.ws.send(JSON.stringify(msg)); this.sent++; return true; } catch { return false; }
  }

  async #pump() {
    while (!this.closed) {
      const item = this.queue[0];
      if (item && item.c.open) {
        this.queue.shift();
        if (!this.#send(item.c, item.msg)) this.queue.unshift(item);
        await sleep(400); // ~150 mensagens/min, abaixo do limite de 200
      } else {
        // conexao do primeiro item fechada: passa os itens das conexoes abertas na frente
        const k = this.queue.findIndex((q) => q.c.open);
        if (k > 0) this.queue.unshift(...this.queue.splice(k, 1));
        else await sleep(200);
      }
    }
  }

  #connect(c) {
    const ws = new WebSocket(this.url);
    c.ws = ws;
    ws.onopen = () => {
      c.open = true; c.fails = 0;
      log('INFO', `ws[${c.i}] conectado, ${c.channels.size} canais a inscrever`);
      // descarta pendencias antigas desta conexao e reinscreve tudo
      this.queue = this.queue.filter((q) => q.c !== c);
      for (const ch of c.channels) this.queue.push({ c, msg: { type: 'subscribe', channel: ch } });
    };
    ws.onmessage = (e) => {
      c.msgs++; this.msgCount++;
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'ping') return this.#send(c, { type: 'pong' });
      if (!m.channel) return;
      const [name, id] = m.channel.split(':');
      try { this.onMessage(name, id, m); } catch (err) { log('ERRO', `handler ${m.channel}: ${err.stack}`); }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      const was = c.open;
      c.open = false;
      if (this.closed) return;
      c.reconnects++;
      if (was) log('AVISO', `ws[${c.i}] desconectado, reconectando`);
      for (const ch of c.channels) this.onReset?.(ch);
      c.fails = (c.fails || 0) + 1;
      setTimeout(() => this.#connect(c), Math.min(30_000, 1000 * c.fails));
    };
  }
}
