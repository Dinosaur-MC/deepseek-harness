# Agent Note: Windows 多 bash 后端——唯一 ctx.shell 席位上的选择器

Status: implemented

[English](2026-08-18-windows-multi-bash-backends.md) | 中文

## 问题

随附的 harness 在 POSIX 上以 bash 为先，在 win32 上仅使用 pwsh：base patch 在 win32 上禁用 bash 栈，因为 bash 没有 Windows 沙箱 runner，面向模型的 bash 工具也因此缺席。社区插件从仓库外桥接 Git Bash 与 WSL，重复工具逻辑、硬编码安装路径并 patch 官方白名单，而官方 seam 始终保持唯一的 `ctx.shell` 席位——第二个 `ShellExecutor` 注册会直接抛错。Windows 用户希望在同一个组合里让 Git Bash 和 WSL bash 与 pwsh 并存，由模型按工具名选择 shell，同时保留 pwsh 默认。

## 决定

**工具名就是 shell 选择器。** `dsh-tool-bash` 提供 `defineShellTool({ toolName, shell, dialect })` 工厂与三个固定实例：`bash`（不变，无 `shell` 字段，POSIX）、`git_bash`（`request.shell: 'git-bash'`，MSYS 方言）与 `wsl_bash`（`request.shell: 'wsl-bash'`，Linux 方言）。`dsh-shell-select` 占据唯一的 `ctx.shell` 席位，把 `request.shell ?? config.default` 路由到某个后端实例；`resolve()` 把选中的名字以 `shellBackend` 盖戳到 spec 上，`run`/`start` 依它路由，未知或未启用的名字抛出 `SHELL_BACKEND_UNAVAILABLE`。

**后端是普通实例，构造在子 fiber 上，既不是组合行，也不在选择器自己的 fiber 上。** vendored Cordis 的 `Service` 构造器立即执行 `ctx.reflect.provide(name, …)` 注册（[vendor/cordis/src/service.ts](../../../../vendor/cordis/src/service.ts)），因此同一作用域内第二个 `ctx.shell` 注册会抛出 `service "shell" has been registered`；`fiber.store` 还会按名覆盖，后构造的执行器会顶掉运行时 `ctx.shell` 的解析。每个后端在自己的子 fiber 上构造，方式为 `ctx.plugin({ inject: ['subprocess', 'sandbox', 'sandboxPolicy'], apply: () => {} })`，并 `isolate('shell', Symbol(name))` + `isolate('settings', Symbol(name))` 隔离作用域。inject 列表是承重结构：裸的 `ctx.plugin(() => {})` fiber 无法为后端解析 `subprocess`/`sandbox`/`sandboxPolicy`，因为 get-trap 遍历要求链路中的 fiber 声明该服务——real-composition loader 冒烟测试证明了这一点，修复随本功能一起交付。隔离 `settings` 使后端继承的 `installSettingsSection` 静默跳过，因为三个后端不可能各自注册同一个 `shell` settings 命名空间。

**`shell` settings 命名空间只归 shell-select 所有。** 存储的 settings 分区叠加在 shell-select 组合条目之上，提交的变更会重建全部后端：旧子 fiber 被 dispose，新后端按新分区配置构造，并在首次使用时重新 probe 沙箱可用性。`bash-local`/`pwsh-local` 不需要任何 settings 改动。

**base 没有独立的 `bash-git`/`bash-wsl` 行。** 把任一执行器作为插件挂载成行都会与 shell-select 争抢 `ctx.shell` 席位，隔离 realm 又会让工具层读不到包装器。所有后端配置经由 shell-select 行的 `gitBash:`/`wslBash:`/`pwsh:` 分区透传，部署者可见的每个旋钮都在。`pwsh-sandbox` base 行在所有平台上静态 `disabled: true`：win32 上它的 pwsh 后端由选择器持有（行为不变），POSIX 上该行同样禁用，行保留以使行身份与依赖声明保持显式。

**可执行文件解析与沙箱 probe 全部惰性化，失败在首次使用时响亮。** 构造永不失败。`resolveBashPath`/`resolveWslPath` 在首次路由命令时运行，Git Bash 或 WSL 缺失时抛出列出全部探测位置的错误；沙箱 probe 在首次读取 `sandboxMode`（工具层 apply 步骤，即组合加载的最后一刻）或首条命令时运行，结论在执行器生命周期内缓存。显式 `bwrap` 模式 probe 失败同样在首次使用时抛出。因此未安装 Git Bash 或 WSL 永远不会破坏同一组合中的 pwsh。

**auto 沙箱契约如实回落。** Git Bash 的 `sandbox: auto` 探测 windows-acl 受限令牌 runner 能否启动 Cygwin bash；在当前主机上不能（社区实证），因此 probe 失败时命令无限制运行，结果不携带沙箱事实。WSL 的 `sandbox: auto` 在发行版内探测 `command -v bwrap`：探测通过则命令在 bwrap 下受限运行，`/` 只读并加 `/dev`/`/proc`，`workspace-write` 额外绑定工作区与可写的 `/tmp`（read-only 不授予任何临时目录写入），探测失败则无限制运行并如实报告，显式 `bwrap` 探测失败在首次使用时抛出。两个后端中 `danger-full-access` 都绕过限制。

**wsl.exe 的命令以 base64 传递。** 朴素的 `bash -c base64(command)` 草图会让 bash 把 base64 文本当命令执行；实际交付的 argv 是 `bash -c "echo <b64> | base64 -d | bash"`。`-c` 参数只含 base64 字母表字符与管道符——没有引号或反斜杠——因此 wsl.exe 的 Windows→Linux 参数序列化无法损坏它，内层 bash 的退出码照常传播。bwrap profile 参数按逐个 argv 元素传递，理由相同；`--cd` 的 Windows 路径转换交给 wsl.exe。

## 曾考虑的替代方案

- **把每个后端挂成独立的组合行**——每个 `ShellExecutor` 子类都在构造器中注册 `ctx.shell`，Cordis 对同一上下文中的第二次注册直接抛错，隔离 realm 又会让工具层读不到包装器；只有选择器能占据席位。
- **在选择器自己的 fiber 上直接构造后端**——`Service` 构造器的即时注册与按名覆盖的 `fiber.store` 会让同一作用域中的第二个执行器要么抛出 `service "shell" has been registered`，要么顶掉运行时 `ctx.shell`；子 fiber 拆分同时避开两者。
- **不带 inject 列表的子 fiber**——loader 冒烟测试表明裸 `ctx.plugin(() => {})` fiber 无法为后端解析 `subprocess`/`sandbox`/`sandboxPolicy`；get-trap 遍历要求 fiber 链声明它们。
- **构造期快速失败**——在构造时急切执行可执行文件与沙箱 probe，会让未安装 Git Bash 或 WSL 的主机连 pwsh 都用不了；惰性首次使用失败在保持响亮的同时让组合其余部分可用。
- **经 wsl.exe 传引号转义的命令参数**——wsl.exe 的参数序列化会损坏引号；base64 载荷因从不含 shell 元字符而天然免疫。
- **每个后端一个 settings 命名空间**——三个执行器不可能注册同一个 `shell` 命名空间，按后端拆分命名空间又会分叉用户可见分区；shell-select 独占命名空间并在变更时重建后端。

## 影响

本功能交付：`bash-git`、`bash-wsl`、`shell-select` 三个包（逐文件 100% 覆盖率，`pnpm run test:coverage`）、带 `git_bash`/`wsl_bash` 实例的 `tool-bash` 工厂、base 与 web-app 组合行，以及 win32 standard preset 的工具行。win32 默认路由保持 `pwsh`（[windows-pwsh-default](../feature/2026-08-01-windows-pwsh-default.md) 记录默认决策；[loader disabled 插值 note](2026-08-11-loader-entry-disabled-interpolation.md) 拥有行门控机制），POSIX 组合按 [capability-seams](2026-06-13-capability-seams.md) 的形态保持 `bash-sandbox` 直接占据席位。

real-composition loader 冒烟测试经 Loader 启动随附的 win32 行，在缺少 Git Bash 或 WSL 的主机上自行跳过；`base.spec.ts` 钉住 win32 行集及其与 POSIX 行的对称性；无 Git Bash 的 CI 车道沿用 bash-local 先例，把 `bash-git`/`bash-wsl` 加入 vitest 的 `windowsUnsupportedPackages` 列表。本同 PR note 一并覆盖 shell-select 子 fiber inject 修复（controller 豁免），文档门禁（`pnpm run doc-sync`：类型等价、生成目录、翻译配对、note 格式）钉住已记录的表面。
