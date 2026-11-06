import { readFileSync, writeFileSync } from 'node:fs';
const p = process.env.HOME + '/work/dsh-termux/lib/termux.mjs';
let s = readFileSync(p, 'utf8');

const oldSig = "export async function runTool({ prefixDir, tool, args = [], stdin, cwd, timeoutMs = 60_000 }) {";
const oldEnv = [
  "  const libDir = join(usr, 'lib');",
  "  const env = {",
  "    ...process.env,",
  "    LD_LIBRARY_PATH: libDir + (process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : ''),",
  "    HOME: process.env.HOME,",
  "    TMPDIR: process.env.TMPDIR || '/data/local/tmp',",
  "  };",
].join('\n');

const newSig = `/**
 * Termux 的包在构建时把 $PREFIX=/data/data/com.termux/files/usr 写死了。我们装在别处，
 * 所以要把「运行时才会去找的那些路径」用环境变量指过来（环境变量优先于编译期默认值）。
 */
export async function buildEnv(usr, extra = {}) {
  const env = { ...process.env };
  const add = async (key, rel) => {
    const target = join(usr, rel);
    try { await stat(target); env[key] = target; } catch {}
  };
  env.LD_LIBRARY_PATH = join(usr, 'lib') + (env.LD_LIBRARY_PATH ? \`:\${env.LD_LIBRARY_PATH}\` : '');
  env.PREFIX = usr;
  env.PATH = join(usr, 'bin') + (env.PATH ? \`:\${env.PATH}\` : ':/system/bin');
  env.TMPDIR = env.TMPDIR || '/data/local/tmp';
  await add('MAGIC', 'share/misc/magic.mgc');       // file
  if (env.MAGIC === undefined) await add('MAGIC', 'share/misc/magic');
  await add('SSL_CERT_FILE', 'etc/tls/cert.pem');   // openssl / curl / wget
  await add('SSL_CERT_DIR', 'etc/tls/certs');
  await add('TERMINFO', 'share/terminfo');          // ncurses / less / vim
  await add('TZDIR', 'share/zoneinfo');             // date / TZ
  await add('GIT_EXEC_PATH', 'libexec/git-core');   // git 的子命令目录
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && value !== undefined && value !== null) env[key] = String(value);
  }
  return env;
}

export async function runTool({ prefixDir, tool, args = [], stdin, cwd, timeoutMs = 60_000, env: extraEnv }) {`;

const newEnv = "  const env = await buildEnv(usr, extraEnv);\n  env.HOME = env.HOME || process.env.HOME;";

for (const [label, from, to] of [['sig', oldSig, newSig], ['env', oldEnv, newEnv]]) {
  if (!s.includes(from)) throw new Error(`${label} 没匹配上`);
  s = s.replace(from, to);
  console.log(`${label} 替换完成`);
}
writeFileSync(p, s);
console.log('写回完成');
