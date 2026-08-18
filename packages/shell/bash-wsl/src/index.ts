/**
 * WSL Service Provider for the bash capability seam: a LocalBashExecutor
 * whose argv is `[wslPath, --cd workdir?, -d distro?, --, bash, -c, payload]`.
 * The command rides as a base64 payload through `echo <b64> | base64 -d | bash`
 * so wsl.exe's Windows→Linux argument serialization can never damage quotes.
 * Sandbox: `auto` probes bubblewrap inside the distro (once, lazily, at the
 * first sandboxMode read or the first command) and runs unconfined without
 * sandbox facts when absent; `bwrap` fails loud at first use when the probe
 * fails; `none` never probes or confines.
 * @module @deepseek-ai/dsh-bash-wsl
 */

import { spawnSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import type { Config as LocalConfig } from '@deepseek-ai/dsh-bash-local'
import type { ConfinedSandboxMode, SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { classifyRunnerFailure } from '@deepseek-ai/dsh-bash-sandbox/helpers'
import { BWRAP_RUNNER_FAILURE_RULES, bwrapProfileArgs } from '@deepseek-ai/dsh-sandbox-local/profiles'
import { candidateWslPaths, parseWslDistroList, resolveWslPath, toWslPath } from './resolve.ts'

/** Sandbox stance for WSL: bwrap inside the distro, best-effort, or none. */
export type WslBashSandbox = 'auto' | 'none' | 'bwrap'

/** Plugin config: local knobs plus the WSL executable, distro, and sandbox stance. */
export interface Config extends LocalConfig {
  /** Explicit wsl.exe path; omitted probes System32 then PATH. */
  wslPath?: string
  /** Explicit distro; omitted probes `wsl -l -q` once for the first listed distro. */
  wslDistro?: string
  /** `auto` probes bwrap and falls back unconfined; `bwrap` fails loud; `none` never probes. */
  sandbox?: WslBashSandbox
  /** Positive timeout for the WSL probes (cold-start aware). */
  probeTimeoutMs?: number
}

/** Test hook: replace the bwrap/distro probes and executable resolution. */
export interface WslBashInternals {
  probeBwrap?: () => boolean
  probeDistro?: () => string | undefined
  resolveWslPath?: (configured?: string) => string | undefined
}

/**
 * WSL executor over the local bash mechanics: argv is the resolved wsl.exe
 * followed by `--cd`/`-d`/`--` `bash -c` with the base64 payload, and the
 * sandbox stance (`auto`/`bwrap`/`none`) is applied lazily per the module
 * doc's probe contract.
 */
export class WslBashExecutor extends LocalBashExecutor {
  static override Config: z<Config> = LocalBashExecutor.Config
    .set('wslPath', z.string())
    .set('wslDistro', z.string())
    .set('sandbox', z.union([z.const('auto'), z.const('none'), z.const('bwrap')]).default('auto'))
    .set('probeTimeoutMs', z.natural().default(30_000))

  /** Test hook mirroring the sandbox-local internals pattern. */
  internals: WslBashInternals = {}

  private readonly sandboxStance: WslBashSandbox
  private readonly probeTimeoutMs: number
  private bwrapVerdict: boolean | undefined
  private distroProbed = false
  private distroVerdict: string | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    const entry = config as Config & { sandbox: WslBashSandbox; probeTimeoutMs: number }
    this.sandboxStance = entry.sandbox
    this.probeTimeoutMs = entry.probeTimeoutMs
    // Probes are lazy (first sandboxMode read or first command), so the
    // internals test hooks can be installed after construction.
  }

  override get sandboxMode(): SandboxMode | undefined {
    if (this.sandboxStance === 'none') return undefined
    return this.requireBwrapUsable() ? this.ctx.sandboxPolicy.defaultMode : undefined
  }

  /** Auto: false means run unconfined. Explicit bwrap: a failed probe throws loud. */
  private requireBwrapUsable(): boolean {
    if (this.probeBwrapOnce()) return true
    if (this.sandboxStance === 'bwrap') {
      throw new Error('bash-wsl: bwrap was not found in the WSL distro (explicit sandbox "bwrap" is configured); install bubblewrap or set sandbox: auto/none')
    }
    return false
  }

  private tryWslPath(): string | undefined {
    const resolve = this.internals.resolveWslPath ?? ((configured?: string) => resolveWslPath(configured))
    // The base getter's ResolvedConfig type predates this executor's extra
    // fields; Config carries wslPath as its optional extension.
    return resolve((this.config as Config).wslPath)
  }

  private wslPath(): string {
    const path = this.tryWslPath()
    if (path !== undefined) return path
    throw new Error(`bash-wsl: WSL was not found (probed ${candidateWslPaths().join(', ')}). Enable Windows Subsystem for Linux or set wslBash.wslPath.`)
  }

  private probeDistroOnce(): string | undefined {
    if (!this.distroProbed) {
      // The probe runs exactly once: a failed/timed-out/empty verdict is
      // cached like a successful one, so a host without a distro never
      // re-runs 'wsl -l -q' (up to probeTimeoutMs) on every routed command.
      this.distroProbed = true
      const probe = this.internals.probeDistro
      if (probe !== undefined) return this.distroVerdict = probe()
      const wsl = this.tryWslPath()
      if (wsl === undefined) {
        /* v8 ignore next 2 -- every executor path resolves wslPath before this probe, so the guard is defensive only. */
        return this.distroVerdict = undefined
      }
      const run = spawnSync(wsl, ['-l', '-q'], { timeout: this.probeTimeoutMs, encoding: 'utf8' })
      this.distroVerdict = run.status === 0 ? parseWslDistroList(run.stdout)[0] : undefined
    }
    return this.distroVerdict
  }

  private distro(): string | undefined {
    return (this.config as Config).wslDistro ?? this.probeDistroOnce()
  }

  private probeBwrapOnce(): boolean {
    if (this.bwrapVerdict !== undefined) return this.bwrapVerdict
    const probe = this.internals.probeBwrap
    if (probe !== undefined) return this.bwrapVerdict = probe()
    const wsl = this.tryWslPath()
    if (wsl === undefined) return this.bwrapVerdict = false
    const distro = this.distro()
    const run = spawnSync(wsl, [...(distro !== undefined ? ['-d', distro] : []), '-e', 'bash', '-c', 'command -v bwrap'], { timeout: this.probeTimeoutMs, stdio: 'ignore' })
    return this.bwrapVerdict = run.status === 0
  }

  private payload(command: string): string {
    const encoded = Buffer.from(command, 'utf8').toString('base64')
    return `echo ${encoded} | base64 -d | bash`
  }

  /** The workdir `resolve()` fills when a request omits one. */
  private defaultWorkdir(): string {
    return this.config.cwd ?? process.cwd()
  }

  /**
   * The plain WSL argv for one spec (no sandbox). `--cd` is passed only when
   * the workdir differs from the default, so the subprocess cwd and the WSL
   * start directory agree without a redundant wsl.exe translation; a Linux
   * workdir passes through verbatim.
   */
  protected argv(spec: ShellExecSpec): string[] {
    const head = [this.wslPath()]
    if (spec.workdir !== this.defaultWorkdir()) head.push('--cd', spec.workdir)
    const distro = this.distro()
    if (distro !== undefined) head.push('-d', distro)
    head.push('--', 'bash', '-c', this.payload(spec.command))
    return head
  }

  private confinedPolicy(spec: ShellExecSpec): SandboxExecutionPolicy {
    return spec.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
  }

  /** The bwrap-wrapped argv; the workspace root is translated to its /mnt/<drive> form. */
  private bwrapArgv(spec: ShellExecSpec): string[] {
    const policy = this.confinedPolicy(spec)
    const linuxRoot = toWslPath(policy.workspaceRoot)
    const head = [this.wslPath()]
    if (spec.workdir !== this.defaultWorkdir()) head.push('--cd', spec.workdir)
    const distro = this.distro()
    if (distro !== undefined) head.push('-d', distro)
    // run()/start() route danger-full-access before this method, so only confined modes arrive.
    const mode = policy.mode as ConfinedSandboxMode
    head.push('--', 'bwrap', ...bwrapProfileArgs({ mode, workspaceRoot: linuxRoot }), 'bash', '-c', this.payload(spec.command))
    return head
  }

  override async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    if (this.sandboxStance === 'none' || !this.requireBwrapUsable()) return this.runArgv(spec, this.argv(spec))
    const policy = this.confinedPolicy(spec)
    if (policy.mode === 'danger-full-access') {
      const result = await this.runArgv(spec, this.argv(spec))
      return { ...result, sandbox: { mode: 'danger-full-access', denied: false } }
    }
    const result = await this.runArgv(spec, this.bwrapArgv(spec))
    // The probe already proved bwrap runs; a matching fatal line means the
    // command never ran — report the honest runnerFailed fact.
    if (classifyRunnerFailure(result.exitCode, result.stderr.text, BWRAP_RUNNER_FAILURE_RULES) !== undefined) {
      return { ...result, sandbox: { mode: policy.mode, denied: false, enforcement: 'full', runnerFailed: true } }
    }
    return { ...result, sandbox: { mode: policy.mode, denied: false, enforcement: 'full' } }
  }

  /** Per-process confinement facts retained until settlement (bash-sandbox pattern). */
  private readonly processFacts = new Map<ShellProcess, { mode: SandboxMode }>()

  override start(spec: ShellExecSpec): ShellProcess {
    if (this.sandboxStance === 'none' || !this.requireBwrapUsable()) return this.startArgv(spec, this.argv(spec))
    const policy = this.confinedPolicy(spec)
    if (policy.mode === 'danger-full-access') return this.startArgv(spec, this.argv(spec))
    const proc = this.startArgv(spec, this.bwrapArgv(spec))
    this.processFacts.set(proc, { mode: policy.mode })
    return proc
  }

  /** Stamp per-process sandbox facts before `done` settles (bash-sandbox semantics). */
  protected override onProcessDone(proc: ShellProcess, stderr: string, spawnFailed: boolean, spawnError?: unknown): void {
    const facts = this.processFacts.get(proc)
    if (facts !== undefined) {
      this.processFacts.delete(proc)
      const runnerFailed = classifyRunnerFailure(proc.exitCode, stderr, BWRAP_RUNNER_FAILURE_RULES) !== undefined
      proc.sandbox = runnerFailed
        ? { mode: facts.mode, denied: false, enforcement: 'full', runnerFailed: true }
        : { mode: facts.mode, denied: false, enforcement: 'full' }
    }
    super.onProcessDone(proc, stderr, spawnFailed, spawnError)
  }

  override resolve(request: ShellExecRequest): ShellExecSpec {
    return { ...super.resolve(request), sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve() }
  }
}

export default WslBashExecutor
