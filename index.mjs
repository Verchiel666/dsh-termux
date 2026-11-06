// dsh-termux — 在 DSH 里装并运行 Android 原生命令行工具。
//
// 背景：Android 10+ 让 app 私有目录里的文件不能 execve（EACCES），而 Termux 仓库里
// 的包是 bionic 构建（PT_INTERP=/system/bin/linker64）。显式让 linker64 加载就能跑：
// SELinux 拦的是 execve，不拦 mmap(PROT_EXEC)。所以这个插件自己解 .deb（纯 JS 解 xz +
// 解 tar），装进 app 私有目录，再用 linker64 起进程——不需要 Shizuku、不需要 root。

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  loadIndex, search, resolvePlan, install, listInstalled, runTool, purgeCache, REPO,
} from './lib/termux.mjs';

export const name = 'termux';
export const inject = ['tools'];

const RISK_NOTE = {
  read: 'risk: read (read-only)',
  write: 'risk: write (changes the phone)',
};

const text = (t) => [{ type: 'text', text: t }];
const renderer = (_args, value) => (Array.isArray(value?.content) ? value.content : text(JSON.stringify(value, null, 2)));

export function apply(ctx, config = {}) {
  const logger = typeof ctx.logger === 'function' ? ctx.logger('termux') : { info() {}, warn() {} };
  const prefixDir = config.prefixDir || join(homedir(), 'work', 'tbins', 'prefix');
  const cacheDir = join(prefixDir, '.cache', 'debs');
  const indexFile = join(prefixDir, '.cache', 'Packages.txt');

  const getIndex = async (refresh = false) => (await loadIndex({ cacheFile: indexFile, refresh })).index;

  const fyi = `prefix: ${prefixDir}`;

  const tools = [
    {
      name: 'termux_search',
      description: `在 Termux 官方仓库（aarch64）里按名字/描述搜包。安装前先用它确认包名。\n[${RISK_NOTE.read}; ${fyi}]`,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词；留空列出全部（按名字排序）' },
          limit: { type: 'number', description: '最多返回几条（默认 20，上限 100）' },
        },
      },
      timeoutMs: 60_000,
      isConcurrencySafe: () => true,
      output: { schema: {}, render: renderer },
      async execute(args) {
        const index = await getIndex();
        const limit = Math.min(Math.max(Number(args?.limit) || 20, 1), 100);
        const hits = search(index, args?.query ?? '', limit);
        if (hits.length === 0) return { content: text(`仓库里没有匹配「${args?.query ?? ''}」的包。`) };
        const lines = hits.map((h) => `${h.name} ${h.version} · ${(h.size / 1024).toFixed(0)} KB · ${(h.description || '').slice(0, 80)}`);
        return { content: text(`共 ${hits.length} 条（索引 ${index.size} 个包）：\n${lines.join('\n')}`) };
      },
    },
    {
      name: 'termux_list',
      description: `列出已装进 ${fyi} 的包、可执行工具和库。\n[${RISK_NOTE.read}]`,
      parameters: { type: 'object', properties: {} },
      timeoutMs: 30_000,
      isConcurrencySafe: () => true,
      output: { schema: {}, render: renderer },
      async execute() {
        const { usr, packages, bins, libs } = await listInstalled(prefixDir);
        const names = Object.keys(packages);
        const lines = [
          `目录：${usr}`,
          `已装包（${names.length}）：${names.length ? names.map((n) => `${n}@${packages[n].version}`).join(', ') : '(空)'}`,
          `可执行（${bins.length}）：${bins.join(' ') || '(空)'}`,
          `库（${libs.length}）：${libs.join(' ') || '(空)'}`,
          bins.length ? '\n用 termux_run 跑它们，例如 {"tool":"jq","args":["--version"]}' : '\n先 termux_install 装点什么。',
        ];
        return { content: text(lines.join('\n')) };
      },
    },
    {
      name: 'termux_install',
      description: `从这个仓库装 aarch64 包到 app 私有目录，装完可用 termux_run 运行（无需 Shizuku/root）。\n依赖会一起装；包体经 SHA256 校验。纯 JS 解 xz + tar。\n[${RISK_NOTE.write}; ${fyi}]`,
      parameters: {
        type: 'object',
        properties: {
          packages: {
            type: 'array',
            items: { type: 'string' },
            description: '包名列表，例如 ["jq"] 或 ["tree","file"]',
          },
          refreshIndex: { type: 'boolean', description: '强制重新拉取索引（默认用 24 小时缓存）' },
        },
        required: ['packages'],
      },
      timeoutMs: 600_000,
      isConcurrencySafe: () => false,
      output: { schema: {}, render: renderer },
      async execute(args, exec) {
        const requested = Array.isArray(args?.packages) ? args.packages : [];
        if (requested.length === 0) throw new Error('packages 不能为空');
        const index = await getIndex(args?.refreshIndex === true);
        if (exec?.signal?.aborted) throw new Error('已取消');
        const logs = [];
        const result = await install({
          packages: requested,
          index,
          prefixDir,
          cacheDir,
          onLog: (m) => { logs.push(m); logger.info?.(m); },
        });
        const lines = [
          `装好了（${result.installed.length} 个包）：`,
          ...result.installed.map((p) => `- ${p.name}@${p.version} ← ${p.files} 个文件 / ${p.bytes} 字节${p.cached ? '（用缓存）' : ''}`),
        ];
        if (result.missing.length) lines.push(`跳过（仓库里没有）：${result.missing.join(', ')}`);
        lines.push(`前缀：${result.prefix}`, '现在可以用 termux_run 运行，例如 {"tool":"jq","args":["--version"]}');
        return { content: text(lines.join('\n')) };
      },
    },
    {
      name: 'termux_run',
      description: `运行已装的工具（用 /system/bin/linker64 加载，绕开 app 私有目录的 execve 限制）。\n只允许运行 prefix/bin 里的工具，不能指定任意路径。\n[${RISK_NOTE.write}; ${fyi}]`,
      parameters: {
        type: 'object',
        properties: {
          tool: { type: 'string', description: '工具名，例如 jq / tree（在 prefix/bin 里）' },
          args: { type: 'array', items: { type: 'string' }, description: '命令行参数' },
          stdin: { type: 'string', description: '喂给标准输入的内容' },
          cwd: { type: 'string', description: '工作目录（默认 home）' },
          timeoutMs: { type: 'number', description: '超时毫秒（默认 60000，上限 300000）' },
        },
        required: ['tool'],
      },
      timeoutMs: 360_000,
      isConcurrencySafe: () => false,
      output: { schema: {}, render: renderer },
      async execute(args) {
        if (!args?.tool) throw new Error('tool 不能为空');
        const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 60_000, 1000), 300_000);
        const res = await runTool({
          prefixDir,
          tool: args.tool,
          args: Array.isArray(args.args) ? args.args : [],
          stdin: args.stdin,
          cwd: args.cwd,
          timeoutMs,
        });
        const parts = [`$ ${res.command}`, `退出码 ${res.code}`];
        if (res.stdout) parts.push('--- stdout ---', res.stdout);
        if (res.stderr) parts.push('--- stderr ---', res.stderr);
        if (!res.stdout && !res.stderr) parts.push('(无输出)');
        return { content: text(parts.join('\n')) };
      },
    },
  ];

  const disposeFns = [];
  ctx.effect(() => {
    for (const def of tools) {
      if (ctx.tools.get?.(def.name) !== undefined) {
        logger.warn?.(`${def.name} 已存在，跳过注册`);
        continue;
      }
      try {
        disposeFns.push(ctx.tools.register(def));
      } catch (error) {
        logger.warn?.(`注册 ${def.name} 失败：${error?.message ?? error}`);
      }
    }
    logger.info?.(`termux: 注册 ${disposeFns.length} 个工具，前缀 ${prefixDir}`);
    return () => {
      for (const dispose of disposeFns.splice(0)) {
        try { dispose(); } catch {}
      }
    };
  }, 'termux.tools');

  // 写类工具走审批：只把 allow 升级成 ask，别处的 deny 仍然赢
  const writeTools = new Set(tools.filter((t) => t.name !== 'termux_search' && t.name !== 'termux_list').map((t) => t.name));
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next();
    if (!writeTools.has(exec.name) || decision?.kind !== 'allow') return decision;
    let argsText = '';
    try { argsText = JSON.stringify(exec.arguments ?? {}); } catch {}
    if (argsText.length > 500) argsText = argsText.slice(0, 500) + '…';
    return { kind: 'ask', reason: `termux 工具「${exec.name}」要在这台手机上装/跑原生工具：${argsText}` };
  });
}

export { REPO, resolvePlan, purgeCache };
