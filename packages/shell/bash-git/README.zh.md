# @deepseek-ai/dsh-bash-git

[English](README.md) | 中文

这是 [`@deepseek-ai/dsh-shell`](../shell/) 执行器 seam 的 Git Bash Service Provider。每条命令都通过解析得到的 Git for Windows `bash.exe` 以 `[bashPath, '-c', command]` 运行——一个干净、不加载 profile 的 MSYS 环境。进程机制（spawn、进程组终止、输出收集/spill、后台句柄、凭证清理）继承自 [`@deepseek-ai/dsh-bash-local`](../bash-local/)。

可执行文件在首次路由命令时惰性解析：`config.bashPath` 原样优先；否则按顺序探测常见 Program Files 安装位置，再探测 PATH 条目。当 Git Bash 缺失时，首次路由的命令会响亮失败，报错信息列出全部探测点。`candidateBashPaths` 与 `resolveBashPath` 是导出的纯函数，以 env/platform 为参数（与 `resolvePwshPath` 成对）。

本执行器以后端普通实例的形式挂在 shell-select 包装器之后（由后续任务实现）；它自身从不注册 `ctx.shell`，因此 shell 单席位服务始终由选择器持有。其旋钮是 `gitBash:` 分区下的部署配置。

## 沙箱模式

| 模式 | 行为 |
|---|---|
| `auto`（默认） | 在每个执行器生命周期内探测一次 `ctx.sandbox` 提供方（Windows 上为 windows-acl）能否启动 Cygwin bash：在首次读取 `sandboxMode`（工具层 apply 步骤）或首次路由命令时，以先到者为准。探测通过：命令受限运行，结果携带沙箱事实。探测失败：命令无限制运行，结果如实不携带任何沙箱事实。 |
| `none` | 从不 consult `ctx.sandbox`；从不报告沙箱事实。 |

语义：

- **Windows 上的限制是尽力而为。** 社区实证表明 windows-acl 受限令牌 runner 无法启动 Cygwin bash，因此 `auto` 回退为无限制执行而不是失败关闭；auto 契约在此处与工具层文档中写明。
- **拒绝与 runner 失败是结果事实。** 受限运行按提供方的 stderr 方言分类拒绝。受限 runner 在执行命令前死亡的，前台重试为无限制执行，后台句柄则盖上 `runnerFailed`；其他 spawn 拒绝保留本地执行器语义。
- **`danger-full-access` 策略绕过限制。** 从不 consult 提供方：前台结果携带 `sandbox: { mode, denied: false }`，后台句柄不携带任何事实。
- probe 在 `probeTimeoutMs`（默认 10s）内通过 `spawnSync` 同步运行一次微不足道的受限 `exit 0`；结论在执行器生命周期内缓存。

```yaml
- id: git-bash
  name: '@deepseek-ai/dsh-bash-git'
  config:
    sandbox: auto
    probeTimeoutMs: 10000
```

## 模型体验

### git_bash 工具（间接）

#### 模型看到的内容

`git_bash` 工具由工具工厂（dsh-tool-bash）在后续任务中基于 shell-select 包装器组装：它把 `git_bash` 调用路由到此后端的 MSYS bash，并携带 `gitBash:` 分区配置。本包贡献后端沙箱立场——`sandboxMode` 能力公告（仅在限制可用时的策略默认模式）——工具层组装工具时读取它。

#### Token 影响

零直接 token：本包不注册任何 prompt 或 schema。组装后的 `git_bash` 工具自带 schema 与方言描述。

#### KV Cache 影响

不使其失效：本包不贡献任何包属请求 token，因此可复用的请求前缀保持逐字节不变。配置或能力变化（例如不同的 `sandbox` 立场）会改变工具层所公告的内容，从而改变组装后的 `git_bash` 工具 schema。

## 已知限制与延期工作

- **Git Bash 没有文件沙箱保障**——在 `auto` 下，失败的受限 probe 会静默地以无限制方式运行命令，结果不携带沙箱事实；在当前主机上 windows-acl runner 无法启动 Cygwin bash（社区实证），因此限制对 Git Bash 不是安全边界。
- **受限 probe 会阻塞首次使用**——首次读取 `sandboxMode`（工具加载）或首次路由命令时会运行一次同步 spawn probe；`probeTimeoutMs` 为其上限，结论在执行器生命周期内缓存。
- **Git Bash 缺失只在首次路由时报错**——构造永不失败；首次 `run`/`start` 抛出列出探测点的错误，因此未安装的后端不会破坏组合中的其他 shell。
- **没有自己的 settings 分区**——`shell` settings 命名空间由 shell-select 包装器持有；本后端的旋钮是部署配置（`gitBash:` 分区），不是用户设置。
