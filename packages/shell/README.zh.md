# shell/ — bash 能力家族

[English](README.md) | 中文

该能力家族涵盖规范执行器 seam、其实现、共享 shell 环境和面向模型的工具。这些全是**产品**包。

| 包 | 职责 | ctx key |
|---|---|---|
| [`shell/`](shell/README.md) | 定义 Service Provider 与 Consumer 共享的执行器约定。 | `ctx.shell` |
| [`bash-local/`](bash-local/README.md) | 通过本地 [`subprocess`](../subprocess/README.md) 服务执行命令。 | （注册 `ctx.shell`） |
| [`bash-sandbox/`](bash-sandbox/README.md) | 在本地执行前应用已配置的 [`sandbox`](../sandbox/README.md) 后端。 | （注册 `ctx.shell`） |
| [`pwsh-local/`](pwsh-local/README.md) | 采用 Windows 特有的进程行为执行 PowerShell 命令。 | （注册 `ctx.shell`） |
| [`bash-git/`](bash-git/README.md) | Git Bash 执行器（win32），由选择器作为后端实例持有。 | （经 `shell-select` 注册） |
| [`bash-wsl/`](bash-wsl/README.md) | WSL bash 执行器（win32），由选择器作为后端实例持有。 | （经 `shell-select` 注册） |
| [`shell-select/`](shell-select/README.md) | 单席位选择器，将 `ctx.shell` 路由到 git-bash / wsl-bash / pwsh 后端（win32 组合）。 | `ctx.shell` |
| [`shell-env/`](shell-env/README.md) | 提供 shell 工具共享的托管 `DSH_*` 环境。 | `ctx.shellEnv` |
| [`tool-bash/`](tool-bash/README.md) | 向模型公开 Bash 执行和后台任务集成。 | （注册到 `ctx.tools`） |
| [`tool-pwsh/`](tool-pwsh/README.md) | 向模型公开 PowerShell 执行。 | （注册到 `ctx.tools`） |

叶节点 `cordis.yml` 选择一个执行器实现和所需的面向模型工具。沙箱化组合还会选择一个 `ctx.sandbox` 提供方；[ACP（Agent Client Protocol）示例](../../examples/acp-agent/)展示一套完整接线。

win32 组合挂载 `shell-select` 并并行持有三个后端（git-bash、wsl-bash、pwsh）；POSIX 组合直接挂载 `bash-sandbox`。

子系统参考——请求/spec 词汇、结果、后台进程、服务与事件——见 [docs/subsystems/shell.md](../../docs/subsystems/shell.md)。
