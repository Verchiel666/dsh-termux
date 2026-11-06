// 最小 ustar/GNU tar 解包器：只要普通文件、目录、符号链接。
// 安全：拒绝绝对路径、..、设备文件，并限制总解压体积（防 zip bomb）。

import { mkdir, writeFile, symlink, rm, chmod } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';

const BLOCK = 512;
const octal = (buf) => {
  const s = buf.toString('ascii').replace(/\0.*$/, '').trim();
  return s === '' ? 0 : Number.parseInt(s, 8) || 0;
};

export function parseTar(buf) {
  const entries = [];
  let off = 0;
  let longName = null;
  while (off + BLOCK <= buf.length) {
    const header = buf.subarray(off, off + BLOCK);
    if (header.every((b) => b === 0)) break; // 结束块
    const name = header.subarray(0, 100).toString().replace(/\0.*$/, '');
    const mode = octal(header.subarray(100, 108));
    const size = octal(header.subarray(124, 136));
    const typeflag = String.fromCharCode(header[156] || 48);
    const prefix = header.subarray(345, 500).toString().replace(/\0.*$/, '');
    const linkname = header.subarray(157, 257).toString().replace(/\0.*$/, '');
    off += BLOCK;
    const body = buf.subarray(off, off + size);
    off += Math.ceil(size / BLOCK) * BLOCK;
    if (typeflag === 'L') { longName = body.toString().replace(/\0.*$/, ''); continue; } // GNU 长名
    const full = longName ?? (prefix ? `${prefix}/${name}` : name);
    longName = null;
    entries.push({ path: full, mode, size, typeflag, linkname, body });
  }
  return entries;
}

/** 路径是否安全（相对、不含 ..） */
export function safeRelPath(p) {
  if (!p) return null;
  const clean = p.replace(/^\.\//, '').replace(/^\/+/, '');
  if (clean === '' || clean === '.') return null;
  const norm = normalize(clean);
  if (norm.startsWith('..') || norm.includes(`..${sep}`) || norm === '..') return null;
  if (/^[a-zA-Z]:/.test(norm)) return null;
  return norm;
}

export async function extractTar(entries, destDir, { maxTotalBytes = 512 * 1024 * 1024, onLog = () => {} } = {}) {
  let total = 0;
  const written = [];
  const skipped = [];
  for (const entry of entries) {
    const rel = safeRelPath(entry.path);
    if (rel === null) { skipped.push(`${entry.path}（不安全路径）`); continue; }
    const target = join(destDir, rel);
    if (!target.startsWith(destDir)) { skipped.push(`${entry.path}（越界）`); continue; }
    try {
      if (entry.typeflag === '5' || (entry.typeflag === '0' && entry.path.endsWith('/'))) {
        await mkdir(target, { recursive: true, mode: entry.mode & 0o777 || 0o755 });
        continue;
      }
      if (entry.typeflag === '0' || entry.typeflag === '' || entry.typeflag === '\0') {
        total += entry.size;
        if (total > maxTotalBytes) throw new Error(`解压体积超过上限 ${maxTotalBytes} 字节`);
        await mkdir(dirname(target), { recursive: true });
        await rm(target, { force: true });
        await writeFile(target, entry.body, { mode: entry.mode & 0o777 || 0o644 });
        written.push(rel);
        continue;
      }
      if (entry.typeflag === '2') { // 符号链接
        await mkdir(dirname(target), { recursive: true });
        await rm(target, { force: true });
        await symlink(entry.linkname, target);
        written.push(rel);
        continue;
      }
      if (entry.typeflag === '1') { // 硬链接：本机不支持硬链接（跨目录 inode 复用），复制内容
        skipped.push(`${entry.path}（硬链接，跳过）`);
        continue;
      }
      skipped.push(`${entry.path}（类型 ${entry.typeflag}，跳过）`);
    } catch (error) {
      skipped.push(`${entry.path}（${error.message}）`);
    }
  }
  onLog(`解包 ${written.length} 个文件，跳过 ${skipped.length} 个，共 ${total} 字节`);
  return { written, skipped, totalBytes: total };
}
