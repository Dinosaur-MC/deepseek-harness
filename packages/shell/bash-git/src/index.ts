/**
 * Git Bash Service Provider for the bash capability seam: a LocalBashExecutor
 * whose argv is `[bashPath, '-c', command]` (MSYS bash, clean profile-less
 * environment). Sandbox policy `auto` probes whether the windows-acl runner
 * can launch Cygwin bash (once, lazily, at the first sandboxMode read or the
 * first routed command); when the probe fails, commands run unconfined and
 * results honestly carry no sandbox facts (the declared auto contract).
 * `none` never consults `ctx.sandbox`. The executable is resolved lazily at
 * the first routed command and fails loud, naming the probes, when Git Bash
 * is missing.
 * @module @deepseek-ai/dsh-bash-git
 */

import { spawnSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import type { Config as LocalConfig } from '@deepseek-ai/dsh-bash-local'
import type { ConfinedArgv, RunnerFailureRule, SandboxEnforcement, SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { classifyDenial, classifyRunnerFailure, isRunnerSpawnFailure, matchesSignature } from '@deepseek-ai/dsh-bash-sandbox/helpers'
import { resolveBashPath } from './resolve.ts'

/** Sandbox stance for Git Bash: best-effort confinement or none. */
export type GitBashSandbox = 'auto' | 'none'

/** Plugin config: local knobs plus the Git Bash executable and sandbox stance. */
export interface Config extends LocalConfig {
  /** Explicit Git Bash executable; omitted probes well-known installs then PATH. */
  bashPath?: string
  /** `auto` probes windows-acl confinement of bash.exe and falls back unconfined; `none` never consults the sandbox. */
  sandbox?: GitBashSandbox
  /** Positive timeout for the confinement probe. */
  probeTimeoutMs?: number
}

/** Test hook: replace the confinement probe and executable resolution. */
export interface GitBashInternals {
  probeConfined?: () => boolean
  resolveBashPath?: (configured?: string) => string | undefined
}

/**
 * Git Bash executor over the local bash mechanics: argv is the resolved
 * `bash.exe` followed by `-c` and the command, and the
 * sandbox stance (`auto`/`none`) is applied lazily per the
 * module doc's probe contract.
 */
export class GitBashExecutor extends LocalBashExecutor {
  static override Config: z<Config> = LocalBashExecutor.Config
    .set('bashPath', z.string())
    .set('sandbox', z.union([z.const('auto'), z.const('none')]).default('auto'))
    .set('probeTimeoutMs', z.natural().default(10_000))

  /** Test hook mirroring the sandbox-local internals pattern. */
  internals: GitBashInternals = {}

  private readonly sandboxStance: GitBashSandbox
  private readonly probeTimeoutMs: number
  private confinedVerdict: boolean | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, config)
    const entry = config as Config & { sandbox: GitBashSandbox; probeTimeoutMs: number }
    this.sandboxStance = entry.sandbox
    this.probeTimeoutMs = entry.probeTimeoutMs
    // Probes are lazy (first sandboxMode read or first command), so the
    // internals test hooks can be installed after construction.
  }

  /** The capability fact: the policy default mode only while confinement is usable. */
  override get sandboxMode(): SandboxMode | undefined {
    if (this.sandboxStance === 'none') return undefined
    return this.probeConfinedOnce() ? this.ctx.sandboxPolicy.defaultMode : undefined
  }

  /** The exact argv every (un)confined command runs through. */
  private gitArgv(spec: ShellExecSpec): string[] {
    return [this.bashPath(), '-c', spec.command]
  }

  /** The resolved Git Bash executable; undefined resolves to a loud route-time error. */
  private tryBashPath(): string | undefined {
    const resolve = this.internals.resolveBashPath
      ?? ((configured?: string) => resolveBashPath(configured))
    // The base getter's ResolvedConfig type predates this executor's extra
    // fields; Config carries bashPath as its optional extension.
    return resolve((this.config as Config).bashPath)
  }

  /** Route-time loud failure naming the probes, per the spec error contract. */
  private bashPath(): string {
    const path = this.tryBashPath()
    if (path !== undefined) return path
    throw new Error(
      'bash-git: Git Bash was not found (probed C:\\Program Files\\Git\\bin\\bash.exe, '
      + 'C:\\Program Files\\Git\\usr\\bin\\bash.exe, C:\\Program Files (x86)\\Git\\bin\\bash.exe, '
      + 'and PATH). Install Git for Windows or set gitBash.bashPath in the shell-select config.',
    )
  }

  /**
   * Probe whether the windows-acl runner can launch bash.exe, once per
   * executor lifetime (lazy: the first sandboxMode read or the first routed
   * command). Runs a trivial confined `exit 0` synchronously (mirroring
   * sandbox-local's defaultProbeWindowsAcl shape); a spawn rejection, a
   * runner-failure exit, or a missing bash.exe all mean no confinement.
   */
  private probeConfinedOnce(): boolean {
    if (this.confinedVerdict !== undefined) return this.confinedVerdict
    const probe = this.internals.probeConfined
    if (probe !== undefined) return this.confinedVerdict = probe()
    const bashPath = this.tryBashPath()
    if (bashPath === undefined) return this.confinedVerdict = false
    const root = this.ctx.sandboxPolicy.resolve().workspaceRoot
    let confined: ConfinedArgv
    try {
      confined = this.ctx.sandbox.confine([bashPath, '-c', 'exit 0'], { mode: 'read-only', workspaceRoot: root })
    } catch {
      return this.confinedVerdict = false
    }
    const runner = confined.argv[0]
    if (runner === undefined) return this.confinedVerdict = false
    const probeRun = spawnSync(runner, confined.argv.slice(1), {
      timeout: this.probeTimeoutMs,
      cwd: root,
      stdio: 'ignore',
    })
    return this.confinedVerdict = probeRun.status === 0
  }

  private confinedPolicy(spec: ShellExecSpec): SandboxExecutionPolicy {
    return spec.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
  }

  override async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    if (this.sandboxStance === 'none' || !this.probeConfinedOnce()) return this.runArgv(spec, this.gitArgv(spec))
    const policy = this.confinedPolicy(spec)
    if (policy.mode === 'danger-full-access') {
      const result = await this.runArgv(spec, this.gitArgv(spec))
      return { ...result, sandbox: { mode: 'danger-full-access', denied: false } }
    }
    const confined = this.ctx.sandbox.confine(this.gitArgv(spec), { ...policy, mode: policy.mode })
    let result: ShellRunResult
    try {
      result = await this.runArgv(spec, confined.argv)
    } catch (error) {
      if (spec.signal?.aborted === true) spec.signal.throwIfAborted()
      // Auto contract: a runner that cannot start is not a fail-closed error;
      // run the command unconfined and honestly omit sandbox facts.
      if (isRunnerSpawnFailure(error, confined.argv[0], spec.workdir)) return this.runArgv(spec, this.gitArgv(spec))
      throw error
    }
    if (classifyRunnerFailure(result.exitCode, result.stderr.text, confined.runnerFailureRules) !== undefined) {
      // The runner died before executing the command (probe race): retry unconfined.
      return this.runArgv(spec, this.gitArgv(spec))
    }
    return {
      ...result,
      sandbox: { mode: policy.mode, denied: classifyDenial(result, confined.denialSignatures), enforcement: confined.enforcement },
    }
  }

  /** Per-process confinement facts retained until settlement (bash-sandbox pattern). */
  private readonly processFacts = new Map<ShellProcess, {
    mode: SandboxMode
    enforcement: SandboxEnforcement
    denialSignatures: readonly string[]
    runnerFailureRules: readonly RunnerFailureRule[]
    runnerProgram: string | undefined
    workdir: string
  }>()

  override start(spec: ShellExecSpec): ShellProcess {
    if (this.sandboxStance === 'none' || !this.probeConfinedOnce()) return this.startArgv(spec, this.gitArgv(spec))
    const policy = this.confinedPolicy(spec)
    if (policy.mode === 'danger-full-access') return this.startArgv(spec, this.gitArgv(spec))
    const confined = this.ctx.sandbox.confine(this.gitArgv(spec), { ...policy, mode: policy.mode })
    let proc: ShellProcess
    try {
      proc = this.startArgv(spec, confined.argv)
    } catch (error) {
      // Auto contract for background starts: fall back unconfined, no facts.
      if (isRunnerSpawnFailure(error, confined.argv[0], spec.workdir)) return this.startArgv(spec, this.gitArgv(spec))
      throw error
    }
    this.processFacts.set(proc, {
      mode: policy.mode,
      enforcement: confined.enforcement,
      denialSignatures: confined.denialSignatures,
      runnerFailureRules: confined.runnerFailureRules,
      runnerProgram: confined.argv[0],
      workdir: spec.workdir,
    })
    return proc
  }

  /** Stamp per-process sandbox facts before `done` settles (bash-sandbox semantics). */
  protected override onProcessDone(proc: ShellProcess, stderr: string, spawnFailed: boolean, spawnError?: unknown): void {
    const facts = this.processFacts.get(proc)
    if (facts !== undefined) {
      this.processFacts.delete(proc)
      const runnerFailed = spawnFailed
        ? isRunnerSpawnFailure(spawnError, facts.runnerProgram, facts.workdir)
        : classifyRunnerFailure(proc.exitCode, stderr, facts.runnerFailureRules) !== undefined
      proc.sandbox = runnerFailed
        ? { mode: facts.mode, denied: false, enforcement: facts.enforcement, runnerFailed: true }
        : { mode: facts.mode, denied: matchesSignature(proc.exitCode, stderr, facts.denialSignatures), enforcement: facts.enforcement }
    }
    super.onProcessDone(proc, stderr, spawnFailed, spawnError)
  }

  override resolve(request: ShellExecRequest): ShellExecSpec {
    return { ...super.resolve(request), sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve() }
  }
}

export default GitBashExecutor
