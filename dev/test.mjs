// dsh-termux 自测：核心逻辑离线跑；网络/运行部分用 DSH_TERMUX_NET=1 打开。
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { parseAr, debData } from '../lib/ar.mjs';
import { parseTar, extractTar, safeRelPath } from '../lib/tar.mjs';
import { parseIndex, resolvePlan, search, install, listInstalled, runTool } from '../lib/termux.mjs';
import * as plugin from '../index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures');
let pass = 0;
const fails = [];
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fails.push(`${name} — ${e.message}`); console.log(`  FAIL ${name} — ${e.message}`); }
};

// ---------- ar ----------
console.log('\nar（.deb 是 ar 归档）');
await t('拒收不是 ar 的文件', () => assert.throws(() => parseAr(Buffer.from('hello')), /ar 归档/));
await t('真实 deb 里取出 data.tar.xz', () => {
  const { data } = debData(readFileSync(join(FIX, 'fd_10.5.1_aarch64.deb')));
  assert.match(data.name, /^data\.tar\.xz$/);
  assert.ok(data.size > 100_000);
});

// ---------- tar ----------
console.log('\ntar');
const mkTar = (files) => {
  const blocks = [];
  for (const [name, content] of files) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name, 0);
    header.write('0000644\0', 100);
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('0', 156);
    header.write('ustar\0', 257);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
};
await t('解析普通文件', () => {
  const entries = parseTar(mkTar([['a/b.txt', 'hello'], ['c.txt', 'x']]));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].path, 'a/b.txt');
  assert.equal(entries[0].body.toString(), 'hello');
});
await t('解包到目录', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't-'));
  try {
    const r = await extractTar(parseTar(mkTar([['x/y.txt', 'data']])), dir);
    assert.equal(r.written.length, 1);
    assert.equal(readFileSync(join(dir, 'x/y.txt'), 'utf8'), 'data');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
await t('拒收绝对路径与 ..', async () => {
  assert.equal(safeRelPath('/etc/passwd'), 'etc/passwd'); // 绝对路径被剥成相对
  assert.equal(safeRelPath('../escape'), null);
  assert.equal(safeRelPath('a/../../b'), null);
  const dir = mkdtempSync(join(tmpdir(), 't-'));
  try {
    const r = await extractTar(parseTar(mkTar([['../evil.txt', 'bad'], ['ok.txt', 'good']])), dir);
    assert.equal(r.written.length, 1, '只该写出 ok.txt');
    assert.equal(r.skipped.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- 索引 ----------
console.log('\n索引 / 依赖');
const SAMPLE = `Package: foo
Version: 1.0
Depends: bar, libc
Size: 1024
Filename: pool/main/f/foo/foo_1.0_aarch64.deb
Description: a foo tool
SHA256: aa

Package: bar
Version: 2.0
Size: 2048
Filename: pool/main/b/bar/bar_2.0_aarch64.deb
Description: bar library
SHA256: bb
`;
const index = parseIndex(SAMPLE);
await t('解析两个包', () => { assert.equal(index.size, 2); assert.equal(index.get('foo').Version, '1.0'); });
await t('依赖闭包把 bar 带上，丢掉 libc', () => {
  const { plan, missing } = resolvePlan(index, ['foo']);
  assert.deepEqual([...plan.keys()].sort(), ['bar', 'foo']);
  assert.deepEqual(missing, []);
});
await t('搜不到时 missing 有记录', () => {
  const { missing } = resolvePlan(index, ['nope']);
  assert.deepEqual(missing, ['nope']);
});
await t('搜索命中描述', () => {
  const hits = search(index, 'library');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, 'bar');
});

// ---------- 插件外壳（假 ctx） ----------
console.log('\n插件注册（假 ctx）');
const makeCtx = () => {
  const registered = new Map();
  const handlers = {};
  const ctx = {
    tools: {
      register: (def) => { registered.set(def.name, def); return () => registered.delete(def.name); },
      get: (n) => registered.get(n),
    },
    on: (evt, fn) => { handlers[evt] = fn; return () => delete handlers[evt]; },
    effect: (fn) => { ctx._cleanup = fn(); },
    logger: () => ({ info() {}, warn() {} }),
    registered, handlers,
  };
  return ctx;
};
await t('注册 4 个工具', () => {
  const ctx = makeCtx();
  plugin.apply(ctx, { prefixDir: join(HERE, 'no-such-prefix') });
  assert.deepEqual([...ctx.registered.keys()].sort(), ['termux_install', 'termux_list', 'termux_run', 'termux_search']);
});
await t('每个工具都有 parameters/description/risk 声明', () => {
  const ctx = makeCtx();
  plugin.apply(ctx, { prefixDir: join(HERE, 'x') });
  for (const [name, def] of ctx.registered) {
    assert.equal(def.parameters.type, 'object', `${name} 的 parameters`);
    assert.match(def.description, /risk: (read|write)/, `${name} 的 risk 说明`);
    assert.equal(typeof def.execute, 'function');
  }
});
await t('effect 清理后工具被摘掉', () => {
  const ctx = makeCtx();
  plugin.apply(ctx, { prefixDir: join(HERE, 'x') });
  assert.equal(ctx.registered.size, 4);
  ctx._cleanup();
  assert.equal(ctx.registered.size, 0);
});
await t('审批钩子：写类工具升级为 ask，读类不动', async () => {
  const ctx = makeCtx();
  plugin.apply(ctx, { prefixDir: join(HERE, 'x') });
  const hook = ctx.handlers['tools/pre-execute'];
  assert.ok(hook, '注册了 tools/pre-execute');
  const allow = async () => ({ kind: 'allow' });
  const ask1 = await hook({ name: 'termux_install', arguments: { packages: ['jq'] } }, allow);
  assert.equal(ask1.kind, 'ask');
  assert.match(ask1.reason, /termux/);
  const read = await hook({ name: 'termux_list', arguments: {} }, allow);
  assert.equal(read.kind, 'allow');
  const denied = await hook({ name: 'termux_run', arguments: { tool: 'jq' } }, async () => ({ kind: 'deny' }));
  assert.equal(denied.kind, 'deny', '别处的 deny 不能被覆盖');
});
await t('termux_list 在空前缀上也能跑', async () => {
  const ctx = makeCtx();
  const dir = mkdtempSync(join(tmpdir(), 'p-'));
  try {
    plugin.apply(ctx, { prefixDir: dir });
    const res = await ctx.registered.get('termux_list').execute({});
    assert.match(res.content[0].text, /已装包（0）/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
await t('termux_run 拒绝路径穿越的工具名', async () => {
  const ctx = makeCtx();
  plugin.apply(ctx, { prefixDir: join(HERE, 'x') });
  await assert.rejects(() => ctx.registered.get('termux_run').execute({ tool: '../../etc/passwd' }), /工具名不合法/);
});

// ---------- 网络 + 真跑（可选） ----------
if (process.env.DSH_TERMUX_NET === '1') {
  console.log('\n联网 + 真跑（DSH_TERMUX_NET=1）');
  const dir = mkdtempSync(join(tmpdir(), 'termux-net-'));
  try {
    const { loadIndex } = await import('../lib/termux.mjs');
    const { index: idx } = await loadIndex({ cacheFile: join(dir, 'Packages.txt') });
    await t('拉索引', () => assert.ok(idx.size > 1000, `只有 ${idx.size} 个包`));
    await t('装 tree（含 libandroid-support 依赖）', async () => {
      const r = await install({ packages: ['tree'], index: idx, prefixDir: dir, cacheDir: join(dir, 'debs') });
      assert.ok(r.installed.some((p) => p.name === 'tree'));
      assert.ok(r.installed.some((p) => p.name === 'libandroid-support'), '依赖要一起装');
    });
    await t('列出来', async () => {
      const l = await listInstalled(dir);
      assert.ok(l.bins.includes('tree'));
    });
    await t('用 linker64 真跑 tree --version', async () => {
      const res = await runTool({ prefixDir: dir, tool: 'tree', args: ['--version'] });
      assert.equal(res.code, 0, res.stderr);
      assert.match(res.stdout, /tree v/);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
} else {
  console.log('\n（跳过联网/真跑；要看就 DSH_TERMUX_NET=1 node dev/test.mjs）');
}

// ---------- buildEnv：把 Termux 写死的 $PREFIX 路径用环境变量指过来 ----------
console.log('\nbuildEnv');
const { buildEnv } = await import('../lib/termux.mjs');
await t('存在的支持文件才设环境变量', async () => {
  const usr = mkdtempSync(join(tmpdir(), 'env-'));
  try {
    mkdirSync(join(usr, 'share/misc'), { recursive: true });
    writeFileSync(join(usr, 'share/misc/magic.mgc'), 'x');
    const env = await buildEnv(usr);
    assert.equal(env.MAGIC, join(usr, 'share/misc/magic.mgc'), 'MAGIC 要指到我们的 magic.mgc');
    assert.equal(env.SSL_CERT_FILE, undefined, '没有证书就别设');
    assert.equal(env.PREFIX, usr);
    assert.ok(env.LD_LIBRARY_PATH.startsWith(join(usr, 'lib')));
    assert.ok(env.PATH.startsWith(join(usr, 'bin')));
  } finally { rmSync(usr, { recursive: true, force: true }); }
});
await t('extra env 覆盖自动值，非法键被忽略', async () => {
  const usr = mkdtempSync(join(tmpdir(), 'env-'));
  try {
    const env = await buildEnv(usr, { PREFIX: '/custom', 'bad key': 'x', OK: 1 });
    assert.equal(env.PREFIX, '/custom');
    assert.equal(env.OK, '1');
    assert.equal(env['bad key'], undefined);
  } finally { rmSync(usr, { recursive: true, force: true }); }
});

console.log(`\n${fails.length ? 'FAILED' : 'PASSED'}: ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  - ${f}`); process.exit(1); }

