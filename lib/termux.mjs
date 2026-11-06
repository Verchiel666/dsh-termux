// dsh-termux 内核：从 Termux 官方仓库装 aarch64 包，并在这台机器上运行它们。
//
// 为什么要这么绕：Android 10+ 让 app 私有目录里的文件不能 execve；但这些包是 bionic 构建
// （PT_INTERP=/system/bin/linker64），显式让 linker64 加载就能跑（SELinux 只拦 execve，不拦 mmap exec）。

import { mkdir, readFile, writeFile, rm, chmod, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { debData } from './ar.mjs';
import { parseTar, extractTar } from './tar.mjs';

export const REPO = 'https://packages.termux.dev/apt/termux-main';
const INDEX_URL = `${REPO}/dists/stable/main/binary-aarch64/Packages`;
const LINKER = '/system/bin/linker64';
const MAX_PACKAGES = 20;
const MAX_DEB_BYTES = 80 * 1024 * 1024;
const DEB_DIR_SUFFIX = 'data/data/com.termux/files/usr';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadXz() {
  const mod = await import('xz-decompress');
  const Ctor = mod.XzReadableStream ?? mod.default?.XzReadableStream;
  if (typeof Ctor !== 'function') throw new Error('xz-decompress 不可用');
  return Ctor;
}

async function xzDecompress(buf) {
  const XzReadableStream = await loadXz();
  const stream = new XzReadableStream(Readable.toWeb(Readable.from([buf])));
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** 解析 apt Packages 索引 */
export function parseIndex(text) {
  const map = new Map();
  for (const stanza of text.split(/\n\n+/)) {
    const fields = {};
    for (const line of stanza.split('\n')) {
      if (!line || line[0] === ' ') continue;
      const i = line.indexOf(':');
      if (i > 0) fields[line.slice(0, i)] = line.slice(i + 1).trim();
    }
    if (fields.Package) map.set(fields.Package, fields);
  }
  return map;
}

const depNames = (d) => (d || '')
  .split(',')
  .map((x) => x.trim().split(/[\s(|:]/)[0])
  .filter((x) => x && x !== 'libc' && !x.startsWith('$'));

export async function loadIndex({ cacheFile, maxAgeMs = 24 * 3600 * 1000, refresh = false } = {}) {
  if (cacheFile) {
    try {
      const info = await stat(cacheFile);
      if (!refresh && Date.now() - info.mtimeMs < maxAgeMs) {
        return { index: parseIndex(await readFile(cacheFile, 'utf8')), cached: true };
      }
    } catch {}
  }
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(INDEX_URL, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`索引 HTTP ${res.status}`);
      const text = await res.text();
      if (cacheFile) {
        await mkdir(dirname(cacheFile), { recursive: true });
        await writeFile(cacheFile, text);
      }
      return { index: parseIndex(text), cached: false };
    } catch (error) {
      lastError = error;
      await sleep(500 * (attempt + 1));
    }
  }
  // 拿不到就用旧缓存
  if (cacheFile) {
    try {
      return { index: parseIndex(await readFile(cacheFile, 'utf8')), cached: true, stale: true };
    } catch {}
  }
  throw new Error(`取不到 Termux 索引：${lastError?.message ?? lastError}`);
}

export function search(index, query, limit = 20) {
  const q = String(query || '').toLowerCase();
  const hits = [];
  for (const [name, p] of index) {
    const hay = `${name} ${p.Description || ''}`.toLowerCase();
    if (!q || hay.includes(q)) {
      hits.push({ name, version: p.Version, size: Number(p.Size) || 0, description: p.Description || '' });
    }
  }
  hits.sort((a, b) => (a.name === q ? -1 : b.name === q ? 1 : a.name.localeCompare(b.name)));
  return hits.slice(0, limit);
}

/** 解析依赖闭包（只收索引里有的，避免因 libc 之类失败） */
export function resolvePlan(index, packages) {
  const plan = new Map();
  const missing = [];
  const queue = [...packages];
  while (queue.length) {
    const name = queue.shift();
    if (plan.has(name)) continue;
    const p = index.get(name);
    if (!p) { missing.push(name); continue; }
    plan.set(name, p);
    for (const dep of depNames(p.Depends)) if (index.has(dep)) queue.push(dep);
  }
  return { plan, missing };
}

async function downloadDeb(entry, cacheDir) {
  const url = `${REPO}/${entry.Filename}`;
  const out = join(cacheDir, `${entry.Package}.deb`);
  try {
    const cached = await readFile(out);
    if (cached.length > 0) return { buf: cached, cached: true };
  } catch {}
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${entry.Package}: 下载 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DEB_BYTES) throw new Error(`${entry.Package}: 包太大（${buf.length} 字节）`);
  if (entry.SHA256) {
    const got = createHash('sha256').update(buf).digest('hex');
    if (got !== entry.SHA256) throw new Error(`${entry.Package}: SHA256 不匹配（期望 ${entry.SHA256}，实得 ${got}）`);
  }
  await mkdir(cacheDir, { recursive: true });
  await writeFile(out, buf);
  return { buf, cached: false };
}

export async function install({ packages, index, prefixDir, cacheDir, onLog = () => {} }) {
  const names = packages.map((p) => String(p).trim()).filter(Boolean);
  if (names.length === 0) throw new Error('没有给出包名');
  if (names.length > MAX_PACKAGES) throw new Error(`一次最多装 ${MAX_PACKAGES} 个包`);
  for (const n of names) if (!/^[a-z0-9][a-z0-9+.-]*$/.test(n)) throw new Error(`包名不合法：${n}`);

  const { plan, missing } = resolvePlan(index, names);
  if (plan.size === 0) throw new Error(`索引里没有这些包：${names.join(', ')}`);

  const installed = [];
  for (const [name, entry] of plan) {
    onLog(`装 ${name} ${entry.Version}${entry.Depends ? `（依赖 ${entry.Depends}）` : ''}`);
    const { buf, cached } = await downloadDeb(entry, cacheDir);
    const { data } = debData(buf);
    const tarBuf = /\.xz$/.test(data.name) ? await xzDecompress(data.data)
      : /\.gz$/.test(data.name) ? gunzipSync(data.data)
      : data.data;
    const entries = parseTar(tarBuf);
    const { written, skipped, totalBytes } = await extractTar(entries, prefixDir, { onLog });
    installed.push({ name, version: entry.Version, debBytes: buf.length, cached, files: written.length, skipped: skipped.length, bytes: totalBytes });
  }

  // 记一份安装清单
  const stateFile = join(prefixDir, '.dsh-termux.json');
  let state = { packages: {} };
  try { state = JSON.parse(await readFile(stateFile, 'utf8')); } catch {}
  for (const p of installed) state.packages[p.name] = { version: p.version, at: new Date().toISOString(), files: p.files };
  await mkdir(prefixDir, { recursive: true });
  await writeFile(stateFile, JSON.stringify(state, null, 2));

  // 让 app 读得到、跑得起来
  await chmodTree(join(prefixDir, DEB_DIR_SUFFIX));

  return { installed, missing, prefix: join(prefixDir, DEB_DIR_SUFFIX) };
}

async function chmodTree(dir, depth = 0) {
  if (depth > 12) return;
  let items;
  try { items = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const item of items) {
    const p = join(dir, item.name);
    try {
      if (item.isDirectory()) { await chmod(p, 0o755); await chmodTree(p, depth + 1); }
      else if (item.isFile()) { await chmod(p, 0o755); }
    } catch {}
  }
}

export async function listInstalled(prefixDir) {
  const usr = join(prefixDir, DEB_DIR_SUFFIX);
  const stateFile = join(prefixDir, '.dsh-termux.json');
  let state = { packages: {} };
  try { state = JSON.parse(await readFile(stateFile, 'utf8')); } catch {}
  let bins = [];
  try {
    const items = await readdir(join(usr, 'bin'), { withFileTypes: true });
    bins = items.filter((i) => i.isFile() || i.isSymbolicLink()).map((i) => i.name).sort();
  } catch {}
  let libs = [];
  try {
    libs = (await readdir(join(usr, 'lib'))).filter((n) => n.endsWith('.so') || n.includes('.so.')).sort();
  } catch {}
  return { usr, packages: state.packages, bins, libs };
}

export function runTool({ prefixDir, tool, args = [], stdin, cwd, timeoutMs = 60_000 }) {
  const usr = join(prefixDir, DEB_DIR_SUFFIX);
  if (!/^[A-Za-z0-9._+-]+$/.test(String(tool))) throw new Error(`工具名不合法：${tool}`);
  const bin = join(usr, 'bin', String(tool));
  const libDir = join(usr, 'lib');
  const env = {
    ...process.env,
    LD_LIBRARY_PATH: libDir + (process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : ''),
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR || '/data/local/tmp',
  };
  const useLinker = process.platform === 'android' || process.env.DSH_TERMUX_NO_LINKER !== '1';
  const cmd = useLinker ? LINKER : bin;
  const argv = useLinker ? [bin, ...args.map(String)] : args.map(String);

  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { env, cwd: cwd || process.env.HOME, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const cap = 200_000;
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.stdout.on('data', (d) => { if (out.length < cap) out += d.toString(); });
    child.stderr.on('data', (d) => { if (err.length < cap) err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout: out, stderr: `${err}\n${e.message}`, command: `${cmd} ${argv.join(' ')}` }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout: out, stderr: err, command: `${cmd} ${argv.join(' ')}` }); });
    if (stdin !== undefined && stdin !== null) child.stdin.end(String(stdin));
    else child.stdin.end();
  });
}

export async function purgeCache(cacheDir) {
  await rm(cacheDir, { recursive: true, force: true });
}
