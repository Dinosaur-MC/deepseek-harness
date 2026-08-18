# @deepseek-ai/dsh-bash-git

English | [中文](README.zh.md)

Git Bash Service Provider for the [`@deepseek-ai/dsh-shell`](../shell/) executor seam. Every command runs through the resolved Git for Windows `bash.exe` as `[bashPath, '-c', command]` — a clean, profile-less MSYS environment. Process mechanics (spawn, process-group kills, output collection/spill, background handles, credential scrub) are inherited from [`@deepseek-ai/dsh-bash-local`](../bash-local/).

The executable is resolved lazily at the first routed command: `config.bashPath` wins verbatim; otherwise the well-known Program Files installs and then PATH entries are probed in order. When Git Bash is missing, the first routed command fails loud with an error naming every probe. `candidateBashPaths` and `resolveBashPath` are exported pure functions parameterized by env/platform (the twin of `resolvePwshPath`).

This executor mounts as a plain backend instance behind the shell-select wrapper; it never registers `ctx.shell` itself, so the single-seat shell service stays owned by the selector. Its knobs are deployment config under the `gitBash:` partition.

## Sandbox modes

| Mode | Behavior |
|---|---|
| `auto` (default) | Probes once per executor lifetime whether the `ctx.sandbox` provider (windows-acl on Windows) can launch Cygwin bash, at the first `sandboxMode` read (the tool layer's apply step) or the first routed command, whichever comes first. Probe passes: commands run confined and results carry sandbox facts. Probe fails: commands run unconfined and results honestly carry no sandbox facts. |
| `none` | Never consults `ctx.sandbox`; no sandbox facts are ever reported. |

Semantics:

- **Confinement is best-effort on Windows.** Community evidence shows the windows-acl restricted-token runner cannot start Cygwin bash, so `auto` falls back to unconfined execution instead of fail-closed; the auto contract is documented here and in the tool layer.
- **Denials and runner failures are result facts.** A confined run classifies denials from the provider's stderr dialect. A confined runner that dies before executing the command retries the command unconfined (foreground) or stamps `runnerFailed` on the settled background handle; other spawn rejections retain local-executor semantics.
- **`danger-full-access` policy bypasses confinement.** The provider is never consulted: foreground results carry `sandbox: { mode, denied: false }` and background handles carry no facts.
- The probe runs a trivial confined `exit 0` synchronously through `spawnSync` under `probeTimeoutMs` (default 10s); the verdict is cached for the executor lifetime.

```yaml
- id: git-bash
  name: '@deepseek-ai/dsh-bash-git'
  config:
    sandbox: auto
    probeTimeoutMs: 10000
```

## Model Experience

### git_bash tool, indirectly

#### What the model sees

The `git_bash` tool is assembled by the tool factory (dsh-tool-bash) over the shell-select wrapper: it routes `git_bash` calls to this backend's MSYS bash with the `gitBash:` partition config. This package contributes the backend's sandbox stance — the `sandboxMode` advertisement (the policy default mode, only while confinement is usable) that the tool layer reads when composing the tool.

#### Token effect

Zero direct tokens: this package registers no prompt or schema. The composed `git_bash` tool owns its own schema and dialect description.

#### KV Cache effect

Does not invalidate: this package contributes no package-owned request tokens, so an already-reusable request prefix stays byte-for-byte intact. A config or capability change (for example a different `sandbox` stance) alters what the tool layer advertises and therefore the assembled `git_bash` tool schema.

## Known Limitations and Deferred Work

- **Git Bash has no file-sandbox guarantee** — under `auto`, a failed confinement probe silently runs commands unconfined and results carry no sandbox facts; on current hosts the windows-acl runner cannot start Cygwin bash (community-verified), so confinement is not a security boundary for Git Bash.
- **The confinement probe blocks first use** — the first `sandboxMode` read (tool load) or the first routed command runs a synchronous spawn probe; `probeTimeoutMs` bounds it, and the verdict is cached for the executor lifetime.
- **A missing Git Bash is reported only at first route** — construction never fails; the first `run`/`start` throws the probe-naming error, so an uninstalled backend does not break other shells in the composition.
- **No settings section of its own** — the `shell` settings namespace is owned by the shell-select wrapper; this backend's knobs are deployment config (`gitBash:` partition), not user settings.
