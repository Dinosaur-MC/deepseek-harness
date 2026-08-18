# Agent Note: Windows defaults to pwsh

Status: implemented

English | [中文](2026-08-01-windows-pwsh-default.zh.md)

## Problem

The harness's shipped execution profile is bash-first on every platform. Windows hosts must install a bash shim (WSL or Git-Bash) or fall back to the POSIX-only `dsh-bash-local` behavior (hardcoded `bash -c` argv, process-group semantics); the model-facing bash tool teaches the bash dialect. The Windows-native foundation shipped in the [pwsh executor and tool decision](2026-08-01-pwsh-tool-and-executor.md) — a PowerShell implementation of the `ctx.shell` seam and a parity `pwsh` tool — but shipped compositions still mounted the bash stack on Windows, so a Windows host without a shim could not run the shipped shell.

## Decision

Windows hosts booting a shipped profile (`dsh web`, `dsh --profile headless`, one-shot tasks) get the PowerShell stack by default; POSIX hosts are unchanged.

- **The base patch gates both shell stacks on its own rows** (the [loader `disabled` interpolation](../architecture/2026-08-11-loader-entry-disabled-interpolation.md) note records the mechanism and the platform-layer fold): `bash-sandbox`/`tool-bash` carry `disabled: !!js process.platform === 'win32'` (bash has no Windows runner), `tool-pwsh` mounts only on win32 with the inverted expression, `pwsh-sandbox` is statically `disabled: true` everywhere, and the win32 `shell-select` row holds the `pwsh` backend (beside `git-bash`/`wsl-bash`) as plain instances — the [Windows multi-bash backends decision](../architecture/2026-08-18-windows-multi-bash-backends.md) owns the selector, and one shared patch file serves every roster. The confined pwsh stack runs over the ACL restricted-token runner, and the permission surface stays exactly as on POSIX (the [Windows ACL restricted-token sandbox](2026-08-08-windows-acl-restricted-token-sandbox.md) note owns that roster). Overriding the shipped default is a composition decision: a Windows host that prefers the direct bash stack or an unconfined pwsh executor overrides these rows through its profile or home `cordis.patch.yml` (the bash-restore recipe must be complete: disable `shell-select` AND re-enable `bash-sandbox`/`tool-bash` — the selector occupies the single `ctx.shell` seat, so an incomplete recipe either leaves no shell executor or fails loud at load with a duplicate `shell` registration) — composition config is the one override channel. The separate `windows.cordis.patch.yml` layer and the launcher's `apps/cli/src/windows-shell.ts` injection are deleted; the layer existed only because entry metadata was static.
- **Module resolution is restored for cold starts.** The profiles-rework CLI dropped the pwsh packages from `apps/cli`'s dependency closure, so `healProfilesModuleFallback` never linked them into `$DSH_HOME/profiles/node_modules` and a fresh Windows host could not resolve the pwsh rows. `apps/cli` and `dsh-base` declare `dsh-pwsh-sandbox`/`dsh-tool-pwsh`, and the executor's dependency chain supplies `dsh-pwsh-local`; the base bundle lists every row plugin as a dependency by house style.

The pwsh GUI rendering shipped earlier with the [pwsh UI presentation matches bash decision](2026-08-05-pwsh-ui-bash-parity.md); the [pwsh tool bash parity decision](2026-08-02-pwsh-tool-bash-parity.md) ships the tool's surface. Nothing in this decision changes POSIX behavior.

## Alternatives considered

**Default Windows to pwsh inside `dsh-bash-local` (one executor, dialect switch).** Rejected for the same reason the executor decision rejected a mode switch: the executor's identity is the shell it spawns, and platform-gated composition is a deployment choice, not an executor config.

**Ship the platform layer from `apps/cli` code instead of a bundle data file.** Rejected: the patch belongs next to the rows it replaces, in the bundle that owns them, so the shipped roster stays visible as composition data and dumps carry its provenance; the launcher contributes only the win32 gate.

**Keep `permission`/`ui-permission` on Windows without a confining runner.** Rejected by the original delivery: `dsh-permission-presets` hard-requires `ctx.shell.sandboxMode` and fails loud at load over an unconfined executor. The later ACL runner removed that premise, so the current roster retains both rows.

**Keep fs path-rule confinement on Windows without an OS runner.** Rejected by the original delivery: an unconfined shell could bypass fs-only path rules. The current ACL runner confines the shell and the fs provider under one policy, so this rejected half-boundary is no longer the shipped shape.

**Ship a `DSH_WINDOWS_SHELL` environment escape hatch.** Rejected: decisive behavior changes belong in composition config, which already overrides the platform layer row by id; a second override channel would split the single source of truth for roster decisions.

## Consequences

- A Windows host running a shipped `dsh` surface gets the confined `pwsh` as its default shell tool and PowerShell as the `ctx.shell` route without configuration; the win32 standard preset additionally ships `git_bash` and `wsl_bash` over the shell-select backends ([multi-bash backends](../architecture/2026-08-18-windows-multi-bash-backends.md)), so the bare POSIX `bash` stays absent but the bash family is present by tool name. On the Web surface the shell TOOL rows come from the session's preset (the [loader `disabled` interpolation](../architecture/2026-08-11-loader-entry-disabled-interpolation.md) note owns the one-plane mechanism): each shipped preset declares `tool-pwsh` gated by `process.platform !== 'win32'` and its `tool-bash` twin by the inverted expression, and the standard preset adds `tool-bash-git`/`tool-bash-wsl` behind the same win32 gate, so the preset layer exposes pwsh plus the bash-family tools on win32 (exactly one shell tool per host on POSIX).
- Windows commands and fs operations share the sandbox policy, permission switcher, and approval service. The ACL runner confines writes but reports `enforcement: 'partial'`; explicit `danger-full-access` remains the approved bypass rather than the platform default.
- POSIX hosts mount the bash stack as before; the pwsh rows and the win32-only `shell-select` row sit disabled in their composition, because the one shared patch file lists every stack and each row gates itself.
- A Windows host that prefers the direct bash stack (e.g. with Git Bash on PATH) overrides the shipped rows through its profile or home `cordis.patch.yml` — disabling `shell-select`/`tool-pwsh` and re-enabling `bash-sandbox`/`tool-bash` (the selector occupies the single `ctx.shell` seat, so an incomplete recipe either leaves no shell executor or fails loud at load with a duplicate `shell` registration) — composition config is the one override channel.

## Verification

- Unit: `apps/cli/tests/windows-shell.spec.ts` composes the REAL shipped bundle layers (dsh-base + dsh-web-app resolved from the app installation) through the boot's patch algorithm and pins the effective per-platform roster — the win32 pwsh roster with the shell-select row's `git-bash`/`wsl-bash`/`pwsh` backends, the POSIX bash roster, and the base-only profile — plus the preset-level shell-tool gates (`tool-bash`/`tool-pwsh`) and the cold-start resolution closure; `packages/bundle/base/tests/base.spec.ts` pins the shell rows' `!!js` platform gates — including `pwsh-sandbox` statically disabled everywhere and `shell-select` mounting only on win32 — and that no separate platform patch ships.
- Keyless: a `dsh --profile <name> --dump-config` shows both stacks in the one shared patch layer, with each row's own `disabled` expression deciding the roster at mount.
- The real-composition smoke boots the web profile on win32 with the pwsh stack mounted (the exact roster this note describes).
