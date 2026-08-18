import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { GitBashExecutor } from '../src/index.ts'
import type { Config, GitBashInternals } from '../src/index.ts'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { ConfinedArgv, SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

const spillDir = mkdtempSync(join(tmpdir(), 'dsh-bash-git-spec-'))

function policy(mode: 'read-only' | 'workspace-write' | 'danger-full-access' = 'read-only'): SandboxExecutionPolicy {
  return { mode, workspaceRoot: process.cwd() }
}

/** A fake subprocess service that records every spawn argv and settles successfully. */
function recordingSubprocess(ctx: Context, spawns: SubprocessSpawnSpec[], failFirstRunner = false) {
  let failing = failFirstRunner
  ctx.provide('subprocess', {
    spawn: (spec: SubprocessSpawnSpec) => {
      if (failing && spec.argv[0] === 'runner') {
        failing = false
        throw Object.assign(new Error(`spawn ${spec.argv[0]} ENOENT`), { code: 'ENOENT', path: 'runner', syscall: `spawn ${spec.argv[0]}` })
      }
      spawns.push(spec)
      const reader = () => ({ text: '', lossy: false, nextOffset: 0, spillPath: undefined })
      return {
        done: Promise.resolve({ exitCode: 0, signal: null }),
        collected: { stdout: { readFrom: reader }, stderr: { readFrom: reader } },
        terminate: () => {},
      }
    },
  })
}

/**
 * Fake-sandbox setup: every spawn is recorded; probes come from internals (set
 * before first use — probes are lazy). The path hook defaults to the bare
 * `bash` command so argv assertions hold on hosts where Git Bash resolves to a
 * real install path; the real-executable smoke test exercises true resolution.
 */
function setup(config: Config = {}, internals: GitBashInternals = { resolveBashPath: () => 'bash' }, failFirstRunner = false) {
  const ctx = new Context()
  const spawns: SubprocessSpawnSpec[] = []
  recordingSubprocess(ctx, spawns, failFirstRunner)
  ctx.provide('sandbox', {
    confine: (_argv: readonly string[], p: { mode: string; workspaceRoot: string }): ConfinedArgv => ({
      argv: ['runner', '--mode', p.mode, '--', ..._argv],
      enforcement: 'partial',
      denialSignatures: ['access is denied'],
      runnerFailureRules: [{ allowedExitCodes: [127], fatalSignatures: ['windows-acl-run: '] }],
    }),
  })
  ctx.provide('sandboxPolicy', { defaultMode: 'read-only', resolve: () => policy('read-only') })
  // The schema must resolve before direct construction (it fills timeoutMs & co).
  const executor = new GitBashExecutor(ctx, GitBashExecutor.Config({ sandbox: 'auto', probeTimeoutMs: 1000, ...config }))
  // Explicit overrides win; the default path stub keeps argv assertions
  // platform-independent (the real smoke test exercises true resolution).
  executor.internals = { resolveBashPath: () => 'bash', ...internals }
  return { ctx, executor, spawns }
}

/** Real-subprocess setup for the smoke test (Linux CI has bash; the win32 lane excludes this suite). */
async function setupReal(config: Config = {}) {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
  ctx.provide('sandboxPolicy', { defaultMode: 'read-only', resolve: () => policy('read-only') })
  const executor = new GitBashExecutor(ctx, GitBashExecutor.Config({ sandbox: 'none', ...config }))
  return { ctx, executor }
}

/**
 * Scripted fake subprocess: each spawn resolves (or rejects) per
 * `outcome`, which receives the spec and its spawn index.
 */
function scriptedSubprocess(
  ctx: Context,
  spawns: SubprocessSpawnSpec[],
  outcome: (spec: SubprocessSpawnSpec, index: number) => {
    exitCode?: number | null
    stderr?: string
    spawnError?: Error
  },
) {
  let index = 0
  ctx.provide('subprocess', {
    spawn: (spec: SubprocessSpawnSpec) => {
      spawns.push(spec)
      const { exitCode = 0, stderr = '', spawnError } = outcome(spec, index++)
      const done = spawnError === undefined
        ? Promise.resolve({ exitCode, signal: null })
        : Promise.reject(spawnError)
      return {
        done,
        collected: {
          stdout: { readFrom: () => ({ text: '', lossy: false, nextOffset: 0, spillPath: undefined }) },
          stderr: { readFrom: () => ({ text: stderr, lossy: false, nextOffset: 0, spillPath: undefined }) },
        },
        terminate: () => {},
      }
    },
  })
}

/** Setup whose probe follows the REAL default path (spawnSync over ctx.sandbox.confine). */
function setupDefaultProbe(
  confine: (_argv: readonly string[], p: { mode: string; workspaceRoot: string }) => ConfinedArgv,
) {
  const ctx = new Context()
  const spawns: SubprocessSpawnSpec[] = []
  recordingSubprocess(ctx, spawns)
  ctx.provide('sandbox', { confine })
  ctx.provide('sandboxPolicy', { defaultMode: 'read-only', resolve: () => policy('read-only') })
  const executor = new GitBashExecutor(ctx, GitBashExecutor.Config({ sandbox: 'auto', probeTimeoutMs: 1000 }))
  return { ctx, executor, spawns }
}

describe('GitBashExecutor', () => {
  it('runs commands through the resolved bash executable', async () => {
    const { executor } = await setupReal()
    const result = await executor.run(executor.resolve({ command: 'echo ok' }))
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('ok\n')
    expect(result.sandbox).toBeUndefined()
  })

  it('advertises no sandbox mode when the confinement probe fails (auto fallback)', () => {
    const { executor } = setup({}, { probeConfined: () => false })
    expect(executor.sandboxMode).toBeUndefined()
  })

  it('advertises the policy default mode when the probe passes', () => {
    const { executor } = setup({}, { probeConfined: () => true })
    expect(executor.sandboxMode).toBe('read-only')
  })

  it('confines argv and stamps sandbox facts when the probe passes', async () => {
    const { executor, spawns } = setup({}, { probeConfined: () => true })
    const result = await executor.run(executor.resolve({ command: 'echo confined', sandboxPolicy: policy('workspace-write') }))
    expect(result.sandbox).toEqual({ mode: 'workspace-write', denied: false, enforcement: 'partial' })
    expect(spawns[0]!.argv).toEqual(['runner', '--mode', 'workspace-write', '--', 'bash', '-c', 'echo confined'])
  })

  it('never consults the sandbox under sandbox: none', async () => {
    const { executor } = setup({ sandbox: 'none' }, { probeConfined: () => { throw new Error('must not probe') } })
    expect(executor.sandboxMode).toBeUndefined()
    const result = await executor.run(executor.resolve({ command: 'true' }))
    expect(result.sandbox).toBeUndefined()
  })

  it('falls back to an unconfined run when a confined runner fails at spawn', async () => {
    const { executor, spawns } = setup({}, { probeConfined: () => true }, true)
    const result = await executor.run(executor.resolve({ command: 'echo retried', sandboxPolicy: policy('workspace-write') }))
    expect(result.sandbox).toBeUndefined()
    expect(spawns.map(s => s.argv)).toEqual([['bash', '-c', 'echo retried']])
  })

  it('stamps sandbox facts on a confined background process settlement', async () => {
    const { executor } = setup({}, { probeConfined: () => true })
    const proc = executor.start(executor.resolve({ command: 'sleep 0.01' }))
    await proc.done
    expect(proc.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'partial' })
  })

  it('falls back to an unconfined background start when the confined runner fails at spawn', () => {
    const { executor, spawns } = setup({}, { probeConfined: () => true }, true)
    const proc = executor.start(executor.resolve({ command: 'sleep 1' }))
    expect(spawns.map(s => s.argv)).toEqual([['bash', '-c', 'sleep 1']])
    expect(proc.sandbox).toBeUndefined()
  })

  it('fails loud at route time when Git Bash is not installed on win32', async () => {
    const { executor } = setup({}, { probeConfined: () => false, resolveBashPath: () => undefined })
    await expect(executor.run(executor.resolve({ command: 'true' }))).rejects.toThrow(/Git Bash was not found/)
  })
})

describe('GitBashExecutor probe internals', () => {
  it('runs the real confinement probe once and caches the verdict', async () => {
    const { executor, spawns } = setupDefaultProbe(
      () => ({ argv: [process.execPath, '-e', 'process.exit(0)'], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }),
    )
    expect(executor.sandboxMode).toBe('read-only')
    // Second read and the routed command both reuse the cached verdict.
    expect(executor.sandboxMode).toBe('read-only')
    const result = await executor.run(executor.resolve({ command: 'true' }))
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
    expect(spawns[0]!.argv).toEqual([process.execPath, '-e', 'process.exit(0)'])
  })

  it('treats a failing probe spawn as no sandbox', () => {
    const { executor } = setupDefaultProbe(
      () => ({ argv: ['dsh-no-such-runner'], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }),
    )
    expect(executor.sandboxMode).toBeUndefined()
  })

  it('treats a throwing confine as no sandbox', () => {
    const { executor } = setupDefaultProbe(() => {
      throw new Error('no backend')
    })
    expect(executor.sandboxMode).toBeUndefined()
  })

  it('treats a runner-less confine as no sandbox', () => {
    const { executor } = setupDefaultProbe(
      () => ({ argv: [], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }),
    )
    expect(executor.sandboxMode).toBeUndefined()
  })

  it('treats an unresolvable bash as no sandbox when probing', () => {
    const { executor } = setup({}, { resolveBashPath: () => undefined })
    expect(executor.sandboxMode).toBeUndefined()
  })
})

describe('GitBashExecutor confined edge paths', () => {
  function confinedSetup(outcome: (spec: SubprocessSpawnSpec, index: number) => {
    exitCode?: number | null
    stderr?: string
    spawnError?: Error
  }, internals: GitBashInternals = { probeConfined: () => true }) {
    const ctx = new Context()
    const spawns: SubprocessSpawnSpec[] = []
    scriptedSubprocess(ctx, spawns, outcome)
    ctx.provide('sandbox', {
      confine: (_argv: readonly string[], p: { mode: string; workspaceRoot: string }): ConfinedArgv => ({
        argv: ['runner', '--mode', p.mode, '--', ..._argv],
        enforcement: 'partial',
        denialSignatures: ['access is denied'],
        runnerFailureRules: [{ allowedExitCodes: [127], fatalSignatures: ['windows-acl-run: '] }],
      }),
    })
    ctx.provide('sandboxPolicy', { defaultMode: 'read-only', resolve: () => policy('read-only') })
    const executor = new GitBashExecutor(ctx, GitBashExecutor.Config({ sandbox: 'auto', probeTimeoutMs: 1000 }))
    executor.internals = { resolveBashPath: () => 'bash', ...internals }
    return { ctx, executor, spawns }
  }

  it('defaults a hand-built spec to the deployment sandbox policy', async () => {
    const { executor } = confinedSetup(() => ({ exitCode: 0 }))
    // A spec built without resolve() carries no sandboxPolicy; the executor
    // falls back to ctx.sandboxPolicy.resolve().
    const result = await executor.run({
      command: 'x',
      workdir: process.cwd(),
      timeoutMs: 1000,
      stdoutMaxBytes: 64000,
      sandboxPolicy: undefined,
    })
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'partial' })
  })

  it('classifies a denied confined run as a sandbox fact', async () => {
    const { executor } = confinedSetup(spec => spec.argv[0] === 'runner'
      ? { exitCode: 1, stderr: 'access is denied' }
      : { exitCode: 0 })
    const result = await executor.run(executor.resolve({ command: 'touch /x', sandboxPolicy: policy('workspace-write') }))
    expect(result.sandbox).toEqual({ mode: 'workspace-write', denied: true, enforcement: 'partial' })
  })

  it('retries unconfined when the confined runner reports a runner failure', async () => {
    const { executor, spawns } = confinedSetup(spec => spec.argv[0] === 'runner'
      ? { exitCode: 127, stderr: 'windows-acl-run: boom' }
      : { exitCode: 0 })
    const result = await executor.run(executor.resolve({ command: 'echo retried' }))
    expect(result.sandbox).toBeUndefined()
    expect(spawns.map(s => s.argv)).toEqual([
      ['runner', '--mode', 'read-only', '--', 'bash', '-c', 'echo retried'],
      ['bash', '-c', 'echo retried'],
    ])
  })

  it('runs unconfined under danger-full-access and reports the fact', async () => {
    const { executor, spawns } = confinedSetup(() => ({ exitCode: 0 }))
    const result = await executor.run(executor.resolve({ command: 'echo full', sandboxPolicy: policy('danger-full-access') }))
    expect(result.sandbox).toEqual({ mode: 'danger-full-access', denied: false })
    expect(spawns[0]!.argv).toEqual(['bash', '-c', 'echo full'])
  })

  it('starts unconfined under danger-full-access without facts', async () => {
    const { executor, spawns } = confinedSetup(() => ({ exitCode: 0 }))
    const proc = executor.start(executor.resolve({ command: 'sleep 0.01', sandboxPolicy: policy('danger-full-access') }))
    await proc.done
    expect(spawns[0]!.argv).toEqual(['bash', '-c', 'sleep 0.01'])
    expect(proc.sandbox).toBeUndefined()
  })

  it('falls back to an unconfined background start when the probe fails', async () => {
    const { executor, spawns } = confinedSetup(() => ({ exitCode: 0 }), { probeConfined: () => false })
    const proc = executor.start(executor.resolve({ command: 'sleep 0.01' }))
    await proc.done
    expect(spawns.map(s => s.argv)).toEqual([['bash', '-c', 'sleep 0.01']])
    expect(proc.sandbox).toBeUndefined()
  })

  it('rejects an upstream abort even when the confined spawn fails first', async () => {
    const { executor } = confinedSetup(spec => spec.argv[0] === 'runner'
      ? { exitCode: 0, spawnError: new Error('boom') }
      : { exitCode: 0 })
    const controller = new AbortController()
    controller.abort()
    await expect(executor.run(executor.resolve({ command: 'x', signal: controller.signal }))).rejects.toThrow()
  })

  it('propagates a confined spawn rejection that is not a runner failure', async () => {
    const { executor } = confinedSetup(spec => spec.argv[0] === 'runner'
      ? { exitCode: 0, spawnError: Object.assign(new Error('boom'), { code: 'EACCES', path: '/elsewhere', syscall: 'spawn' }) }
      : { exitCode: 0 })
    await expect(executor.run(executor.resolve({ command: 'x' }))).rejects.toThrow(/boom/)
  })

  it('stamps runnerFailed on a background process whose confined spawn rejects', async () => {
    const { executor } = confinedSetup((spec) => {
      if (spec.argv[0] !== 'runner') return { exitCode: 0 }
      return {
        exitCode: 0,
        spawnError: Object.assign(new Error('spawn runner ENOENT'), { code: 'ENOENT', path: 'runner', syscall: 'spawn runner' }),
      }
    })
    const proc = executor.start(executor.resolve({ command: 'sleep 0.01' }))
    await proc.done
    expect(proc.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'partial', runnerFailed: true })
  })

  it('keeps background facts for a non-runner spawn rejection', async () => {
    const { executor } = confinedSetup(spec => spec.argv[0] === 'runner'
      ? { exitCode: 0, spawnError: new Error('boom') }
      : { exitCode: 0 })
    const proc = executor.start(executor.resolve({ command: 'sleep 0.01' }))
    await proc.done
    expect(proc.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'partial' })
  })

  it('propagates a synchronous non-runner spawn failure from background start', () => {
    const ctx = new Context()
    const spawns: SubprocessSpawnSpec[] = []
    ctx.provide('subprocess', {
      spawn: (spec: SubprocessSpawnSpec) => {
        spawns.push(spec)
        if (spec.argv[0] === 'runner') throw new Error('sync boom')
        const reader = () => ({ text: '', lossy: false, nextOffset: 0, spillPath: undefined })
        return {
          done: Promise.resolve({ exitCode: 0, signal: null }),
          collected: { stdout: { readFrom: reader }, stderr: { readFrom: reader } },
          terminate: () => {},
        }
      },
    })
    ctx.provide('sandbox', {
      confine: (_argv: readonly string[]): ConfinedArgv => ({
        argv: ['runner', '--', ..._argv],
        enforcement: 'partial',
        denialSignatures: [],
        runnerFailureRules: [],
      }),
    })
    ctx.provide('sandboxPolicy', { defaultMode: 'read-only', resolve: () => policy('read-only') })
    const executor = new GitBashExecutor(ctx, GitBashExecutor.Config({ sandbox: 'auto', probeTimeoutMs: 1000 }))
    executor.internals = { probeConfined: () => true }
    expect(() => executor.start(executor.resolve({ command: 'sleep 0.01' }))).toThrow(/sync boom/)
  })
})
