# @deepseek-ai/dsh-shell-select

English | [中文](README.zh.md)

Selector Service Provider for the [`@deepseek-ai/dsh-shell`](../shell/) executor seam. This executor occupies the single `ctx.shell` seat and routes each request to one of several backends held as plain instances — the Git Bash executor ([`@deepseek-ai/dsh-bash-git`](../bash-git/)), the WSL executor ([`@deepseek-ai/dsh-bash-wsl`](../bash-wsl/)), and the sandboxed PowerShell executor ([`@deepseek-ai/dsh-pwsh-sandbox`](../pwsh-sandbox/)). win32 compositions mount this selector and mount no other `ctx.shell` provider; POSIX compositions keep a single backend directly on the seat.

The model-facing tool name selects the backend: the tool factory (dsh-tool-bash) sends `request.shell: 'git-bash' | 'wsl-bash'`, a request without `shell` goes to the configured `default`, and `resolve()` stamps the chosen name onto the spec as `shellBackend` so `run`/`start` route the same spec consistently. Unknown or disabled names fail loud with the `SHELL_BACKEND_UNAVAILABLE` error code. `sandboxMode` advertises the first sandbox mode any enabled backend declares, which the tool layer reads when composing the tool.

Each backend is constructed on its own child fiber with isolated `shell`/`settings` scopes, so the backends' inherited `ctx.shell` service registration and settings wiring can never collide with this executor's seat. Construction never probes: executable resolution and sandbox probes stay lazy inside the backends and only run at first use, so an uninstalled Git Bash or WSL distro does not break the other shells in the composition.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `backends` | `[git-bash, wsl-bash, pwsh]` | Enabled backend names, in advertisement order |
| `default` | `pwsh` | Route for requests without `shell` (web-app overlay pins pwsh; deployment may override) |
| `gitBash` | `{}` | Config partition resolved by the Git Bash executor's schema |
| `wslBash` | `{}` | Config partition resolved by the WSL executor's schema |
| `pwsh` | `{}` | Config partition resolved by the PowerShell executor's schema |

The `shell` settings namespace is owned by this package: a stored section layers over the composition entry, and a committed change rebuilds every backend (disposing the old child fibers and re-probing sandbox availability on first use).

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

## Model Experience

### git_bash / wsl_bash / pwsh tools

#### What the model sees

The three shell tools route through this executor's single `ctx.shell` seat. The tool factory (dsh-tool-bash) sets `request.shell` per tool name; this package's `backends`/`default` config decides which backend instances exist, and the `sandboxMode` advertisement (the first mode any enabled backend declares) feeds the tool layer's escalation presentation. The package itself registers no prompt or schema.

#### Token effect

Zero direct tokens: this package registers no prompt or schema. The composed shell tools own their own schemas and dialect descriptions.

#### KV Cache effect

Does not invalidate: this package contributes no package-owned request tokens, so an already-reusable request prefix stays byte-for-byte intact. A config or capability change (for example a different `backends` set or a backend's `sandbox` stance) alters what the tool layer advertises and therefore the assembled shell tools.

## Known Limitations and Deferred Work

- **Backends are plain instances, not composition rows** — there are no standalone git-bash/wsl-bash/pwsh rows behind the selector; all backend config flows through the `gitBash:`/`wslBash:`/`pwsh:` partitions, and a settings change rebuilds the instances (re-probing sandbox availability) and drops the old child fibers.
- **win32-only** — POSIX compositions keep a single backend directly on the `ctx.shell` seat; this selector is only mounted by win32 compositions, and its backends target Windows executables.
- **First-use probe blocking** — construction never probes, but the first `sandboxMode` read (the tool layer's apply step) or the first routed command runs each backend's sandbox/executable probes serially; each probe is bounded by that backend's `probeTimeoutMs`.
- **Unknown backend names fail at first use** — an enabled name with no factory (a config typo) throws when the initial rebuild runs at the first route, and routing to a name that is not enabled throws `SHELL_BACKEND_UNAVAILABLE`.
