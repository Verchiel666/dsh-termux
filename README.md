# dsh-termux

**在 DSH 里装并运行 Android 原生命令行工具。** 从 Termux 官方仓库取 aarch64 包，纯 JS 解压（xz + tar，无原生依赖），
用 `/system/bin/linker64` 加载执行 —— 不需要 root，不需要 Shizuku。

## 为什么需要它

Android 10+ 之后，app 私有目录里的文件**不能** `execve`（一跑就是 `Permission denied`）。而 Termux 仓库里的包是
bionic 构建（`PT_INTERP=/system/bin/linker64`）。SELinux 拦的是 `execve`，不拦 `mmap(PROT_EXEC)` ——
所以显式让 linker64 加载就能跑起来。这个插件把「下包 → 解压 → 装进私有目录 → 用 linker64 起进程」串成了四个工具。

## 工具

| 工具 | 风险 | 干什么 |
|---|---|---|
| `termux_search` | read | 在仓库里按名字/描述搜包（先确认包名再装） |
| `termux_list` | read | 列出已装的包、可执行文件、库 |
| `termux_install` | write | 装包（依赖一起装，SHA256 校验，解 xz/tar） |
| `termux_run` | write | 用 linker64 运行 prefix/bin 里的工具（只能跑已装的，不接受任意路径） |

写类工具走 DSH 的 `tools/pre-execute` 审批：只把 `allow` 升级成 `ask`，别处的 `deny` 仍然赢。

## 配置

```yaml
# cordis.patch.yml
- insert:
    - id: termux
      name: dsh-termux
      config:
        prefixDir: ''   # 留空 = $HOME/work/tbins/prefix
```

## 边界（说清楚，别误会）

- 只有**单进程**工具能这么跑。需要 fork 子进程的工具（git、包管理器、任何 `popen` 的）会被 execve 限制挡住，
  那种场景要么整条走 Shizuku 的 `adb_shell`，要么等 Android 放宽 W^X。
- 包里的**脚本**（shebang 指 `/data/data/com.termux/files/usr/bin/sh`）跑不了——那个路径在这台机器上不存在。
- 依赖库靠 `LD_LIBRARY_PATH` 指到 `prefix/data/data/com.termux/files/usr/lib`；Termux 的 rpath 是它自己的绝对路径，别指望。
- 网络只连 `packages.termux.dev`（索引 + 包体），索引缓存 24 小时，`.deb` 缓存在 `prefix/.cache/debs`。
- 装的是**别人的二进制**：来源是 Termux 官方仓库并有 SHA256 校验，但你仍然应该知道自己装的是什么。

## 装法

```
在 DSH 的插件管理里装 dsh-termux，重启引擎
```

装完在会话里就有 `termux_search / termux_install / termux_list / termux_run`。

## 实测（2026-11-06，Android 17 / aarch64）

- 装 `jq`（带 oniguruma）、`tree`（带 libandroid-support）、`fd` 全部成功；`termux_run {"tool":"jq","args":["--version"]}` → `jq-1.8.2`。
- 离线自测 `node dev/test.mjs`：15 项通过（ar/tar/索引/依赖/注册/审批/路径穿越拒绝）。
- 联网 + 真跑 `DSH_TERMUX_NET=1 node dev/test.mjs`：19 项通过（含真装 `tree` 并用 linker64 跑起来）。
- 真 cordis 宿主冒烟：5 项通过（加载、注册 4 个工具、execute、render、dispose 清理）。
- `dsh-standards` ENTRY 检查：mandatory=5 · pass=4 · warn=0 · fail=0；唯一 advisory 是 DSC-11
  （`subprocess`、`fs:write` 已声明，但静态触发规则只认 `ctx.subprocess`/`ctx.fs`，我这里用的是 `child_process` 和直接 fs 调用）。

## License

MIT
