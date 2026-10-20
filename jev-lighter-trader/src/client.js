import fs from 'node:fs';
import path from 'node:path';

/** Cliente da API System One da TypeSafe (modelo JEV): POST /v1/systemone com {model, state, questions}. */
export const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const PRICE_PER_INPUT_TOKEN = 0.042 / 1e6; // US$; saida gratuita

/** le chaves simples KEY=valor de um .env (sem dependencias) */
export function readEnv(file) {
  const env = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch { /* sem .env */ }
  return env;
}

export class JevClient {
  constructor({ key, model = 'jev-latest', timeoutMs = 45_000, retries = 3 }) {
    if (!key) throw new Error('TYPESAFE_KEY ausente no .env');
    Object.assign(this, { key, model, timeoutMs, retries });
    this.calls = 0; this.errors = 0; this.inputTokens = 0;
  }

  get cost() { return this.inputTokens * PRICE_PER_INPUT_TOKEN; }

  async decide(state, questions) {
    let last;
    for (let a = 0; a <= this.retries; a++) {
      try {
        const res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.model, state, questions }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const text = await res.text();
        if (res.ok) {
          const body = JSON.parse(text);
          this.calls++; this.inputTokens += body.usage?.input_tokens ?? 0;
          return body;
        }
        last = new Error(`JEV HTTP ${res.status}: ${text.slice(0, 200)}`);
        if (![408, 429, 500, 502, 503, 504].includes(res.status)) break; // erro do pedido: nao adianta repetir
      } catch (e) { last = e; }
      if (a < this.retries) await new Promise((r) => setTimeout(r, 1000 * 2 ** a + Math.random() * 500));
    }
    this.errors++;
    throw last;
  }
}

export const envFile = (dir) => path.join(dir, '.env');
