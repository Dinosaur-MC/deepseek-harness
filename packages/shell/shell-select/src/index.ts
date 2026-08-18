/**
 * Selector Service Provider for the bash capability seam: occupies the single
 * `ctx.shell` seat and routes each request to one of several backends held as
 * plain instances. The tool name selects the backend (`request.shell`); a
 * request without one goes to the configured `default`. Backends are
 * constructed on their own child fibers with isolated `shell`/`settings`
 * scopes so their inherited Service registration and settings wiring cannot
 * collide with this executor's own seat. win32 compositions only; POSIX
 * compositions keep a single backend directly on the seat.
 * @module @deepseek-ai/dsh-shell-select
 */

import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { SHELL_SETTINGS_NAMESPACE, ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { GitBashExecutor } from '@deepseek-ai/dsh-bash-git'
import type { Config as GitBashConfig } from '@deepseek-ai/dsh-bash-git'
import { WslBashExecutor } from '@deepseek-ai/dsh-bash-wsl'
import type { Config as WslBashConfig } from '@deepseek-ai/dsh-bash-wsl'
import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox'
import type { Config as PwshConfig } from '@deepseek-ai/dsh-pwsh-sandbox'
import { assertServiceableBashConfig } from '@deepseek-ai/dsh-bash-local'
import { assertServiceablePwshConfig } from '@deepseek-ai/dsh-pwsh-local'

/** Error code for routing to an unknown or disabled backend. */
export const SHELL_BACKEND_UNAVAILABLE = 'SHELL_BACKEND_UNAVAILABLE'

/** The minimal executor face the wrapper needs (the full ShellExecutor works too). */
export interface BackendExecutor {
  readonly sandboxMode: SandboxMode | undefined
  resolve(request: ShellExecRequest): ShellExecSpec
  run(spec: ShellExecSpec): Promise<ShellRunResult>
  start(spec: ShellExecSpec): ShellProcess
}

/** Backend constructor signature used by the default factory map and test hooks. */
export type BackendFactory = (ctx: Context, config: never) => BackendExecutor

/** Selector plugin config: enabled backend names, the default route, and per-backend partitions. */
export interface Config {
  /** Enabled backend names, in advertisement order (default: git-bash, wsl-bash, pwsh). */
  backends?: string[]
  /** Default route for requests without `shell` (deployment decides; web-app pins pwsh). */
  default?: string
  /** Git Bash backend config partition, resolved by the Git Bash executor's schema. */
  gitBash?: GitBashConfig
  /** WSL bash backend config partition, resolved by the WSL executor's schema. */
  wslBash?: WslBashConfig
  /** PowerShell backend config partition, resolved by the sandbox pwsh executor's schema. */
  pwsh?: PwshConfig
}

/** Test hook: replace backend construction wholesale. */
export interface ShellSelectInternals {
  factories?: Record<string, BackendFactory>
}

/**
 * The shape after schemastery applied the defaults: the partitions deep-resolve
 * to their owning schema's defaults (the nested `.default({})` contract), so
 * every assert below sees a fully-resolved object.
 */
type ResolvedConfig = Required<Omit<Config, 'gitBash' | 'wslBash' | 'pwsh'>> & {
  gitBash: GitBashConfig
  wslBash: WslBashConfig
  pwsh: PwshConfig
}

const DEFAULT_FACTORIES: Record<string, BackendFactory> = {
  'git-bash': (ctx, config) => new GitBashExecutor(ctx, GitBashExecutor.Config(config)),
  'wsl-bash': (ctx, config) => new WslBashExecutor(ctx, WslBashExecutor.Config(config)),
  pwsh: (ctx, config) => new SandboxPwshExecutor(ctx, SandboxPwshExecutor.Config(config)),
}

/**
 * Selector executor over the bash capability seam. Registers as `ctx.shell`
 * (the single seat), routes every request to one enabled backend by name, and
 * stamps the chosen name on the resolved spec as `shellBackend`. Enabled
 * names without a factory fail loud at the first rebuild; routing to an
 * unbuilt name throws `SHELL_BACKEND_UNAVAILABLE`.
 */
export class ShellSelectExecutor extends ShellExecutor {
  static inject = ['subprocess', 'sandbox', 'sandboxPolicy']

  static Config: z<Config> = z.object({
    backends: z.array(z.string()).default(['git-bash', 'wsl-bash', 'pwsh']),
    default: z.string().default('pwsh'),
    gitBash: GitBashExecutor.Config.default({}),
    wslBash: WslBashExecutor.Config.default({}),
    pwsh: SandboxPwshExecutor.Config.default({}),
  })

  /** Test hook: replace backend construction wholesale (mirrors the sandbox-local internals pattern). */
  internals: ShellSelectInternals = {}

  /** The currently authoritative config: the settings section, or the composition entry. */
  private source: () => ResolvedConfig
  private readonly backends = new Map<string, BackendExecutor>()
  private readonly fibers: Fiber[] = []

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const entry = config as ResolvedConfig
    assertServiceableBashConfig(entry.gitBash)
    assertServiceableBashConfig(entry.wslBash)
    assertServiceablePwshConfig(entry.pwsh)
    this.source = () => entry
    // The initial backend construction is deferred to the first use (see
    // ensureBackends): the internals factory hook is installed AFTER the
    // constructor, and the plan's probe-laziness precedent makes construction
    // never fail. A settings attach/change rebuilds from the settings source.
    installSettingsSection(ctx, SHELL_SETTINGS_NAMESPACE, ShellSelectExecutor.Config, entry, {
      validate: (value) => {
        const v = value as ResolvedConfig
        assertServiceableBashConfig(v.gitBash)
        assertServiceableBashConfig(v.wslBash)
        assertServiceablePwshConfig(v.pwsh)
      },
      setSource: (current) => {
        this.source = current as () => ResolvedConfig
      },
      // A settings change rebuilds the instances (re-probing sandbox
      // availability) and drops the old fibers.
      onChange: () => {
        this.rebuildBackends(this.config)
      },
    })
  }

  /** Validated config (schemastery applied the defaults before construction). */
  get config(): ResolvedConfig {
    return this.source()
  }

  /** The first sandbox mode any enabled backend declares (tool-layer advertisement). */
  override get sandboxMode(): SandboxMode | undefined {
    this.ensureBackends()
    for (const name of this.config.backends) {
      const mode = this.backends.get(name)?.sandboxMode
      if (mode !== undefined) return mode
    }
    return undefined
  }

  override resolve(request: ShellExecRequest): ShellExecSpec {
    this.ensureBackends()
    const name = request.shell ?? this.config.default
    const backend = this.requireBackend(name)
    return { ...backend.resolve(request), shellBackend: name }
  }

  override run(spec: ShellExecSpec): Promise<ShellRunResult> {
    this.ensureBackends()
    return this.requireBackend(spec.shellBackend ?? this.config.default).run(spec)
  }

  override start(spec: ShellExecSpec): ShellProcess {
    this.ensureBackends()
    return this.requireBackend(spec.shellBackend ?? this.config.default).start(spec)
  }

  private requireBackend(name: string): BackendExecutor {
    const backend = this.backends.get(name)
    if (backend === undefined) {
      throw new HarnessError(
        `shell-select: backend "${name}" is not enabled (enabled: ${[...this.backends.keys()].join(', ')})`,
        SHELL_BACKEND_UNAVAILABLE,
      )
    }
    return backend
  }

  /** The first rebuild runs at first use, after the internals hook is installed. */
  private ensureBackends(): void {
    if (this.backends.size > 0) return
    this.rebuildBackends(this.config)
  }

  /**
   * Construct one backend per enabled name on its own child fiber with
   * isolated shell/settings scopes (see the class doc), or throw for an
   * unknown name. Old fibers are disposed first so rebuilds never leak.
   */
  private rebuildBackends(entry: ResolvedConfig): void {
    for (const fiber of this.fibers.splice(0)) void fiber.dispose()
    this.backends.clear()
    for (const name of entry.backends) {
      const factory = this.internals.factories?.[name] ?? DEFAULT_FACTORIES[name]
      if (factory === undefined) {
        throw new Error(`shell-select: unknown backend "${name}" (enabled: ${entry.backends.join(', ')})`)
      }
      // Backends run real executor code against `subprocess`/`sandbox`/
      // `sandboxPolicy`, so the child fiber must declare those injects: Cordis
      // resolves a service only into fibers that list it (the walk throws
      // `cannot get property X without inject` otherwise), and a bare function
      // plugin would leave every real backend unable to spawn or confine.
      const fiber = this.ctx.plugin({
        inject: ['subprocess', 'sandbox', 'sandboxPolicy'],
        apply: () => {},
      })
      this.fibers.push(fiber)
      const backendCtx = fiber.ctx.isolate('shell', Symbol(name)).isolate('settings', Symbol(name))
      this.backends.set(name, factory(backendCtx, backendConfig(name, entry)))
    }
  }
}

/**
 * The config partition for one backend name. Names without a dedicated
 * partition (test-hook factories) receive an empty config; the owning factory
 * decides what it needs.
 */
function backendConfig(name: string, entry: ResolvedConfig): never {
  switch (name) {
    case 'git-bash': return entry.gitBash as never
    case 'wsl-bash': return entry.wslBash as never
    case 'pwsh': return entry.pwsh as never
    default: return {} as never
  }
}

export default ShellSelectExecutor
