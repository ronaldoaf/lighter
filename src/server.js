import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { recentLog, log, BAR, barStart } from './util.js';

/** Dashboard: pagina unica (public/index.html) + /api/state (JSON) + /api/stream (SSE, a cada 2s) + /api/trend (forca de tendencia, 1x/hora). */
export function startServer(port, app, host) {
  const html = path.resolve('public/index.html');

  const state = () => {
    const { strategy, recorder, ws, bars } = app;
    const now = Date.now();
    return {
      now, status: app.status, startedAt: app.startedAt, nextBar: barStart(now) + BAR,
      config: { strategy: app.cfg.strategy, sizing: app.cfg.sizing,
        strategyC2: app.strategyC2?.cfg ?? null, sizingC2: app.strategyC2?.sz ?? null },
      strategy: strategy?.view() ?? null,
      strategyC2: app.strategyC2?.view() ?? null,
      momentum: app.momentum?.view() ?? null,
      recorder: recorder?.status() ?? null,
      ws: ws?.status() ?? null,
      rest: app.rest ? { chamadas: app.rest.calls, erros: app.rest.errors, ultimoRefreshSeg: (bars?.refreshMs ?? 0) / 1000 } : null,
      markets: app.markets.length, log: recentLog().slice(-40),
    };
  };

  const costs = () => {
    const { recorder } = app;
    if (!recorder) return [];
    const rows = [];
    for (const [sym, b] of recorder.books) {
      const t = b.ready ? b.top() : null;
      if (!t) continue;
      rows.push({ sym, cls: app.cls.get(sym) ?? 'cripto', spread: (t.ask - t.bid) / t.mid, c1k: b.cost(1000), c5k: b.cost(5000),
        c20k: b.cost(20000), calm: recorder.calmCost(sym), hot: recorder.isHot(sym), age: Date.now() - b.updatedAt });
    }
    return rows;
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
        return fs.createReadStream(html).pipe(res);
      }
      if (url.pathname === '/api/trend') return json(res, app.trend?.view(url.searchParams.get('lag') ?? 0) ?? null); // lag em barras de 15m
      if (url.pathname === '/api/jev') return json(res, app.jev?.view() ?? null);
      if (url.pathname === '/api/shadow') return json(res, app.shadow?.view() ?? null);
      if (url.pathname === '/api/cohorts') return json(res, app.cohorts?.view() ?? null);
      if (url.pathname === '/api/state') return json(res, { ...state(), costs: costs() });
      if (url.pathname === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
        send('state', state()); send('costs', costs());
        let n = 0;
        const iv = setInterval(() => { send('state', state()); if (++n % 3 === 0) send('costs', costs()); }, 2000);
        req.on('close', () => clearInterval(iv));
        return;
      }
      res.writeHead(404); res.end('nao encontrado');
    } catch (e) {
      log('ERRO', `http ${url.pathname}: ${e.message}`);
      res.writeHead(500); res.end(e.message);
    }
  });
  server.listen(port, host, () => log('INFO', `dashboard em http://${host ?? 'localhost'}:${port}`));
  return server;
}

function json(res, obj) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj, (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v)));
}
