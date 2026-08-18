# @deepseek-ai/dsh-shell-select

[English](README.md) | 中文

这是 [`@deepseek-ai/dsh-shell`](../shell/) 执行器 seam 的选择器 Service Provider。本执行器占据唯一的 `ctx.shell` 席位，把每个请求路由到若干个以后端普通实例形式持有的后端之一——Git Bash 执行器（[`@deepseek-ai/dsh-bash-git`](../bash-git/)）、WSL 执行器（[`@deepseek-ai/dsh-bash-wsl`](../bash-wsl/)）与沙箱 PowerShell 执行器（[`@deepseek-ai/dsh-pwsh-sandbox`](../pwsh-sandbox/)）。win32 组合挂载本选择器且不再挂载其他 `ctx.shell` 提供方；POSIX 组合保持单个后端直接占据席位。

模型可见的工具名选择后端：工具工厂（dsh-tool-bash）发送 `request.shell: 'git-bash' | 'wsl-bash'`，不带 `shell` 的请求走配置的 `default`，`resolve()` 把选中的名字以 `shellBackend` 盖戳到 spec 上，使 `run`/`start` 对同一 spec 一致路由。未知或未启用的名字以 `SHELL_BACKEND_UNAVAILABLE` 错误码响亮失败。`sandboxMode` 公告任一启用后端声明的第一个沙箱模式，工具层组装工具时读取它。

每个后端在自己的子 fiber 上构造，并隔离 `shell`/`settings` 作用域，因此后端继承的 `ctx.shell` 服务注册与 settings 接线永远不会与本执行器的席位冲突。构造从不 probe：可执行文件解析与沙箱 probe 在后端内部保持惰性，只在首次使用时运行，因此未安装 Git Bash 或 WSL 发行版不会破坏组合中的其他 shell。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `backends` | `[git-bash, wsl-bash, pwsh]` | 启用的后端名，按公告顺序 |
| `default` | `pwsh` | 不带 `shell` 的请求的路由（web-app overlay 钉住 pwsh；部署者可覆盖） |
| `gitBash` | `{}` | 由 Git Bash 执行器 schema 解析的配置分区 |
| `wslBash` | `{}` | 由 WSL 执行器 schema 解析的配置分区 |
| `pwsh` | `{}` | 由 PowerShell 执行器 schema 解析的配置分区 |

`shell` settings 命名空间由本包持有：存储的分区在组合条目之上叠加，提交的变更会重建每个后端（dispose 旧子 fiber，并在首次使用时重新 probe 沙箱可用性）。

```yaml
- id: shell-select
  name: '@deepseek-ai/dsh-shell-select'
  config:
    backends: [git-bash, wsl-bash, pwsh]
    default: pwsh
    gitBash:
      sandbox: auto
    wslBash:
      sandbox: auto
    pwsh: {}
```

## 模型体验

### git_bash / wsl_bash / pwsh 工具

#### 模型看到的内容

三个 shell 工具都通过本执行器的唯一 `ctx.shell` 席位路由。工具工厂（dsh-tool-bash）按工具名设置 `request.shell`；本包的 `backends`/`default` 配置决定存在哪些后端实例，`sandboxMode` 公告（任一启用后端声明的第一个模式）供给工具层的升权展示。本包自身不注册任何 prompt 或 schema。

#### Token 影响

零直接 token：本包不注册任何 prompt 或 schema。组装后的 shell 工具自带 schema 与方言描述。

#### KV Cache 影响

不使其失效：本包不贡献任何包属请求 token，因此可复用的请求前缀保持逐字节不变。配置或能力变化（例如不同的 `backends` 集合或某后端的 `sandbox` 立场）会改变工具层所公告的内容，从而改变组装后的 shell 工具。

## 已知限制与延期工作

- **后端是普通实例，不是组合行**——选择器之后没有独立的 git-bash/wsl-bash/pwsh 行；所有后端配置经由 `gitBash:`/`wslBash:`/`pwsh:` 分区透传，settings 变更会重建实例（重新 probe 沙箱可用性）并丢弃旧子 fiber。
- **仅 win32**——POSIX 组合保持单个后端直接占据 `ctx.shell` 席位；本选择器只由 win32 组合挂载，其后端面向 Windows 可执行文件。
- **首次使用时的 probe 阻塞**——构造从不 probe，但首次读取 `sandboxMode`（工具层 apply 步骤）或首次路由命令时会串行运行每个后端的沙箱/可执行文件 probe；每个 probe 由该后端的 `probeTimeoutMs` 限定。
- **未知后端名在首次使用时失败**——没有工厂的启用名（配置笔误）会在首次路由的初始重建时抛出，而路由到未启用的名字会抛出 `SHELL_BACKEND_UNAVAILABLE`。
