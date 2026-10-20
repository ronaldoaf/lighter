import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';

export const BAR = 15 * 60_000;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const barStart = (t) => Math.floor(t / BAR) * BAR;
export const day = (t) => new Date(t).toISOString().slice(0, 10);

const LOG = [];
export function log(level, msg, extra) {
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`;
  console.log(line);
  LOG.push({ t: Date.now(), level, msg });
  if (LOG.length > 300) LOG.shift();
}
export const recentLog = () => LOG.slice(-100);

export function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function readJSON(f, fallback) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
}

/** grava atomico: escreve em .tmp e renomeia, para nao corromper o estado se o processo cair no meio */
export function writeJSON(f, obj) {
  ensureDir(path.dirname(f));
  fs.writeFileSync(f + '.tmp', JSON.stringify(obj));
  fs.renameSync(f + '.tmp', f);
}

/** CSV com cabecalho escrito na criacao do arquivo */
export class CsvLog {
  constructor(file, cols) {
    this.file = file; this.cols = cols;
    ensureDir(path.dirname(file));
    if (!fs.existsSync(file)) fs.writeFileSync(file, cols.join(',') + '\n');
  }
  append(row) {
    fs.appendFileSync(this.file, this.cols.map((c) => fmt(row[c])).join(',') + '\n');
  }
}

/** Arquivos diarios (um por dia UTC) com escrita em buffer; ao virar o dia, o arquivo anterior e comprimido em .gz */
export class DailyFile {
  constructor(dir, name, header) {
    this.dir = dir; this.name = name; this.header = header;
    this.cur = null; this.buf = []; this.bytes = 0;
  }
  file(d) { return path.join(this.dir, d, this.name); }
  write(t, line) {
    const d = day(t);
    if (d !== this.cur) {
      this.flush();
      const prev = this.cur;
      this.cur = d;
      ensureDir(path.join(this.dir, d));
      const f = this.file(d);
      if (this.header && !fs.existsSync(f)) fs.writeFileSync(f, this.header + '\n');
      if (prev) gzipFile(this.file(prev));
    }
    this.buf.push(line);
    if (this.buf.length >= 2000) this.flush();
  }
  flush() {
    if (!this.buf.length || !this.cur) return;
    const s = this.buf.join('\n') + '\n';
    fs.appendFileSync(this.file(this.cur), s);
    this.bytes += s.length; this.buf = [];
  }
}

export async function gzipFile(f) {
  if (!fs.existsSync(f)) return;
  try {
    await pipeline(fs.createReadStream(f), zlib.createGzip({ level: 6 }), fs.createWriteStream(f + '.gz'));
    fs.unlinkSync(f);
  } catch (e) { log('ERRO', `gzip ${f}: ${e.message}`); }
}

export function fmt(v) {
  if (v === undefined || v === null || (typeof v === 'number' && !Number.isFinite(v))) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(+v.toPrecision(8));
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function dirSize(d) {
  let n = 0;
  if (!fs.existsSync(d)) return 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    n += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return n;
}
