# @deepseek-ai/dsh-bash-wsl

[English](README.md) | 中文

这是 [`@deepseek-ai/dsh-shell`](../shell/) 执行器 seam 的 WSL Service Provider。每条命令都通过解析得到的 `wsl.exe` 以 `[wslPath, --cd workdir?, -d distro?, --, bash, -c, payload]` 运行——命令以 base64 形式经 `echo <b64> | base64 -d | bash` 传递，使 wsl.exe 的 Windows→Linux 参数序列化永远无法破坏引号。进程机制（spawn、进程组终止、输出收集/spill、后台句柄、凭证清理）继承自 [`@deepseek-ai/dsh-bash-local`](../bash-local/)。

可执行文件在首次路由命令时惰性解析：`config.wslPath` 原样优先；否则按顺序探测 System32，再探测 PATH 条目。当 WSL 缺失时，首次路由的命令会响亮失败，报错信息列出全部探测点。发行版为 `config.wslDistro`（已设置时），否则取 `wsl -l -q` 首行（探测一次并缓存；探测失败回退到默认发行版，即不带 `-d`）。`candidateWslPaths`、`resolveWslPath`、`parseWslDistroList` 与 `toWslPath` 是导出的纯函数，以 env/platform 为参数。

本执行器以后端普通实例的形式挂在 shell-select 包装器之后（由后续任务实现）；它自身从不注册 `ctx.shell`，因此 shell 单席位服务始终由选择器持有。其旋钮是 `wslBash:` 分区下的部署配置。

## 沙箱模式

| 模式 | 行为 |
|---|---|
| `auto`（默认） | 在每个执行器生命周期内探测一次发行版内是否可运行 bubblewrap（`command -v bwrap`）：在首次读取 `sandboxMode`（工具层 apply 步骤）或首次路由命令时，以先到者为准。探测通过：命令在 bwrap 下受限运行，结果携带沙箱事实。探测失败：命令无限制运行，结果如实不携带任何沙箱事实。 |
| `bwrap` | 要求安装 bubblewrap：探测失败时在首次读取 `sandboxMode` 或首次路由命令时响亮抛出。 |
| `none` | 从不探测；命令始终无限制运行，从不报告沙箱事实。 |

语义：

- **bubblewrap 是发行版内真正的文件效果边界。** profile 将 `/` 只读绑定（另有 `/dev` 与 `/proc`）；`workspace-write` 额外绑定工作区根目录（转换为 `/mnt/<drive>` 形式）与可写的 `/tmp`。probe 已证明 bwrap 可运行，因此失败运行中匹配 `bwrap:` 致命行时如实报告 `runnerFailed` 事实，而不是 denial。
- **bwrap 不报告 denial。** profile 从结构上约束文件效果；被阻止的写入表现为普通命令失败，因此 bwrap 运行从不声称 `denied`。
- **`danger-full-access` 策略绕过限制。** 前台结果携带 `sandbox: { mode, denied: false }`，后台句柄不携带任何事实。
- **probe 惰性且缓存。** 构造永不失败；首次读取 `sandboxMode` 或首次命令时在 `probeTimeoutMs`（默认 30s，考虑 WSL 冷启动）内同步运行 probe，结论在执行器生命周期内缓存。
- **仅当 workdir 与默认值不同时才传 `--cd`**（使子进程 cwd 与 WSL 起始目录一致，避免多余转换）；Linux 路径 workdir 原样透传。

```yaml
- id: wsl-bash
  name: '@deepseek-ai/dsh-bash-wsl'
  config:
    sandbox: auto
    probeTimeoutMs: 30000
```

## 模型体验

### wsl_bash 工具（间接）

#### 模型看到的内容

`wsl_bash` 工具由工具工厂（dsh-tool-bash）在后续任务中基于 shell-select 包装器组装：它把 `wsl_bash` 调用路由到此后端的 WSL bash，并携带 `wslBash:` 分区配置。本包贡献后端沙箱立场——`sandboxMode` 能力公告（仅在 bwrap 可用时的策略默认模式）——工具层组装工具时读取它。

#### Token 影响

零直接 token：本包不注册任何 prompt 或 schema。组装后的 `wsl_bash` 工具自带 schema 与方言描述。

#### KV Cache 影响

不使其失效：本包不贡献任何包属请求 token，因此可复用的请求前缀保持逐字节不变。配置或能力变化（例如不同的 `sandbox` 立场）会改变工具层所公告的内容，从而改变组装后的 `wsl_bash` 工具 schema。

## 已知限制与延期工作

- **WSL 冷启动延迟**——首次发行版/bwrap probe（以及首条命令）在 WSL VM 冷启动时可能耗时数秒；`probeTimeoutMs` 约束 probe，且所有 probe 结论在执行器生命周期内缓存。
- **发行版探测取 `-l -q` 首行**——探测失败（或 WSL 无发行版）时命令回退到默认发行版（不带 `-d`）；多发行版主机若不设置 `wslDistro`，只能使用列出的第一个发行版。
- **解码管线依赖发行版的 `base64`**——没有 coreutils 的发行版无法运行命令；这是 WSL 用户态的常规假设。
- **含空格的工作区路径经 wsl.exe 序列化可能损坏**——base64 载荷保护命令文本，但 `--cd` workdir 与 `/mnt/<drive>` 工作区绑定以普通参数传递；部署时应保持工作区根路径无空格。
- **bwrap 只做文件效果约束**——网络与进程可见性不在 bwrap 词汇表内，与沙箱 seam 的文件效果策略一致；它不是网络或进程沙箱。
- **显式 `bwrap` 模式 probe 失败在首次使用时报告**——构造永不失败；首次读取 `sandboxMode` 或首次路由命令时抛出，因此未安装的后端不会破坏组合中的其他 shell。
- **WSL 缺失只在首次路由时报错**——构造永不失败；首次 `run`/`start` 抛出列出探测点的错误。
- **没有自己的 settings 分区**——`shell` settings 命名空间由 shell-select 包装器持有；本后端的旋钮是部署配置（`wslBash:` 分区），不是用户设置。
