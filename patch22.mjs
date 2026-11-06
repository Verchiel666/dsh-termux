import { readFileSync, writeFileSync } from 'node:fs';
const p = process.env.HOME + '/work/dsh-termux/lib/termux.mjs';
let s = readFileSync(p, 'utf8');
const before = s;

// 1) 抽出 buildEnv：按 prefix 里实际存在的文件，补上 Termux 硬编码路径对应的环境变量
s = s.replace(
  "export async function runTool({ prefixDir, tool, args = [], stdin, cwd, timeoutMs = 60_000 }) {",
  `/**
 * Termux 的包在构建时把 $PREFIX=/data/data/com.termux/files/usr 写死了。我们装在别处，
 * 所以要把「程序运行时才会去找的那些路径」用环境变量指过来（环境变量优先于编译期默认值）。
 */
export async function buildEnv(usr, extra = {}) {
  const env = { ...process.env };
  const add = async (key, rel) => {
    const p = join(usr, rel);
    try { await stat(p); env[key] = p; } catch {}
  };
  env.LD_LIBRARY_PATH = join(usr, 'lib') + (env.LD_LIBRARY_PATH ? \`:\${env.LD_LIBRARY_PATH}\` : '');
  env.PREFIX = usr;
  env.PATH = join(usr, 'bin') + (env.PATH ? \`:\${env.PATH}\` : ':/system/bin');
  env.TMPDIR = env.TMPDIR || '/data/local/tmp';
  await add('MAGIC', 'share/misc/magic.mgc');           // file
  await add('MAGIC', 'share/misc/magic');
  await add('SSL_CERT_FILE', 'etc/tls/cert.pem');       // openssl / curl / wget
  await add('SSL_CERT_DIR', 'etc/tls/certs');
  await add('TERMINFO', 'share/terminfo');              // ncurses / less / vim
  await add('TZDIR', 'share/zoneinfo');                 // date / TZ
  await add('GIT_EXEC_PATH', 'libexec/git-core');       // git 的子命令目录
  for (const [k, v] of Object.entries(extra)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && v !== undefined && v !== null) env[k] = String(v);
  }
  return env;
}

export async function runTool({ prefixDir, tool, args = [], stdin, cwd, timeoutMs = 60_000, env: extraEnv }) {`,
);
if (s === before) throw new Error('patch A failed');

// 2) runTool 用 buildEnv 替换原来手工拼的 env
s = s.replace(
  /  const env = \{\n    \.\.\.process\.env,\n    LD_LIBRARY_PATH: libDir \+ \(process\.env\.LD_LIBRARY_PATH \? `:\$\{process\.env\.LD_LIBRARY_PATH\}` : ''\),\n    HOME: process\.env\.HOME,\n    TMPDIR: process\.env\.TMPDIR \|\| '\/data\/local\/tmp',\n  \};\n/,
  "  const env = await buildEnv(usr, extraEnv);\n  env.HOME = env.HOME || process.env.HOME;\n",
);
const after = readFileSync(p, 'utf8');
if (!after.includes('const env = await buildEnv(usr, extraEnv);')) throw new Error('patch B failed');
writeFileSync(p, after);
console.log('termux.mjs patched (buildEnv)');
