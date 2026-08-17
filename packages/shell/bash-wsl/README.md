# @deepseek-ai/dsh-bash-wsl

English | [中文](README.zh.md)

WSL Service Provider for the [`@deepseek-ai/dsh-shell`](../shell/) executor seam. Every command runs through the resolved `wsl.exe` as `[wslPath, --cd workdir?, -d distro?, --, bash, -c, payload]` — the payload rides as base64 through `echo <b64> | base64 -d | bash` so wsl.exe's Windows→Linux argument serialization can never damage quotes. Process mechanics (spawn, process-group kills, output collection/spill, background handles, credential scrub) are inherited from [`@deepseek-ai/dsh-bash-local`](../bash-local/).

The executable is resolved lazily at the first routed command: `config.wslPath` wins verbatim; otherwise System32 and then PATH entries are probed in order. When WSL is missing, the first routed command fails loud with an error naming every probe. The distro is `config.wslDistro` when set, else the first line of `wsl -l -q` (probed once and cached; a failed probe falls back to the default distro, i.e. no `-d`). `candidateWslPaths`, `resolveWslPath`, `parseWslDistroList`, and `toWslPath` are exported pure functions parameterized by env/platform.

This executor mounts as a plain backend instance behind the shell-select wrapper (later tasks); it never registers `ctx.shell` itself, so the single-seat shell service stays owned by the selector. Its knobs are deployment config under the `wslBash:` partition.

## Sandbox modes

| Mode | Behavior |
|---|---|
| `auto` (default) | Probes once per executor lifetime whether bubblewrap runs inside the distro (`command -v bwrap`), at the first `sandboxMode` read (the tool layer's apply step) or the first routed command, whichever comes first. Probe passes: commands run confined under bwrap and results carry sandbox facts. Probe fails: commands run unconfined and results honestly carry no sandbox facts. |
| `bwrap` | Requires bubblewrap: a failed probe throws loud at the first `sandboxMode` read or the first routed command. |
| `none` | Never probes; commands always run unconfined and no sandbox facts are ever reported. |

Semantics:

- **Bubblewrap is a real file-effect boundary inside the distro.** The profile binds `/` read-only (plus `/dev` and `/proc`), and `workspace-write` additionally bind-mounts the workspace root (translated to its `/mnt/<drive>` form) and a writable `/tmp`. The probe already proved bwrap runs, so a matching `bwrap:` fatal line on a failed run reports the honest `runnerFailed` fact instead of a denial.
- **Denials are not reported for bwrap.** The profile constrains file effects structurally; a blocked write surfaces as an ordinary command failure, so bwrap runs never claim `denied`.
- **`danger-full-access` policy bypasses confinement.** Foreground results carry `sandbox: { mode, denied: false }` and background handles carry no facts.
- **Probes are lazy and cached.** Construction never fails; the first `sandboxMode` read or the first command runs the synchronous probes under `probeTimeoutMs` (default 30s, WSL cold-start aware) and caches the verdicts for the executor lifetime.
- **`--cd` is passed only when the workdir differs from the default** (so the subprocess cwd and the WSL start directory agree without a redundant translation); a Linux workdir passes through verbatim.

```yaml
- id: wsl-bash
  name: '@deepseek-ai/dsh-bash-wsl'
  config:
    sandbox: auto
    probeTimeoutMs: 30000
```

## Model Experience

### wsl_bash tool, indirectly

#### What the model sees

The `wsl_bash` tool is assembled by the tool factory (dsh-tool-bash) over the shell-select wrapper in a later task: it routes `wsl_bash` calls to this backend's WSL bash with the `wslBash:` partition config. This package contributes the backend's sandbox stance — the `sandboxMode` advertisement (the policy default mode, only while bwrap is usable) that the tool layer reads when composing the tool.

#### Token effect

Zero direct tokens: this package registers no prompt or schema. The composed `wsl_bash` tool owns its own schema and dialect description.

#### KV Cache effect

Does not invalidate: this package contributes no package-owned request tokens, so an already-reusable request prefix stays byte-for-byte intact. A config or capability change (for example a different `sandbox` stance) alters what the tool layer advertises and therefore the assembled `wsl_bash` tool schema.

## Known Limitations and Deferred Work

- **WSL cold-start latency** — the first distro/bwrap probe (and the first command) can take seconds on a cold WSL VM; `probeTimeoutMs` bounds the probes, and every probe verdict is cached for the executor lifetime.
- **The distro probe takes the first `-l -q` line** — when the probe fails (or WSL has no distro), commands run against the default distro (no `-d`); a multi-distro host cannot select anything but the first listed distro without `wslDistro`.
- **The decode pipeline depends on the distro's `base64`** — a distro without coreutils cannot run commands; this is the standard WSL userland assumption.
- **Workspace paths containing spaces may be damaged by wsl.exe serialization** — the base64 payload protects the command text, but the `--cd` workdir and the `/mnt/<drive>` workspace bind are passed as plain arguments; deployments should keep the workspace root space-free.
- **bwrap constrains file effects only** — network and process visibility are outside the bwrap vocabulary, matching the sandbox seam's file-effect policy; it is not a network or process sandbox.
- **Explicit `bwrap` probe failure is reported at first use** — construction never fails; the first `sandboxMode` read or the first routed command throws, so an uninstalled backend does not break other shells in the composition.
- **A missing WSL is reported only at first route** — construction never fails; the first `run`/`start` throws the probe-naming error.
- **No settings section of its own** — the `shell` settings namespace is owned by the shell-select wrapper; this backend's knobs are deployment config (`wslBash:` partition), not user settings.
