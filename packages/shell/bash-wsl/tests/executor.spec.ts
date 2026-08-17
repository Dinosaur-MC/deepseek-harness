import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { WslBashExecutor } from '../src/index.ts'
import type { Config, WslBashInternals } from '../src/index.ts'
import { resolveWslPath } from '../src/resolve.ts'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

const spillDir = mkdtempSync(join(tmpdir(), 'dsh-bash-wsl-spec-'))

/** The exact payload argv the executor appends for one command. */
function payload(command: string): string {
  return `echo ${Buffer.from(command, 'utf8').toString('base64')} | base64 -d | bash`
}

function policy(mode: 'read-only' | 'workspace-write' | 'danger-full-access' = 'read-only'): SandboxExecutionPolicy {
  // A Windows-style root keeps toWslPath assertions platform-independent on
  // every test host (the executor translates workspace roots for bwrap).
  return { mode, workspaceRoot: 'C:\\ws' }
}

/** A fake subprocess service that records every spawn argv and settles successfully. */
function recordingSubprocess(ctx: Context, spawns: SubprocessSpawnSpec[]) {
  ctx.provide('subprocess', {
    spawn: (spec: SubprocessSpawnSpec) => {
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

function setup(config: Config = {}, internals: WslBashInternals = {}) {
  const ctx = new Context()
  const spawns: SubprocessSpawnSpec[] = []
  recordingSubprocess(ctx, spawns)
  ctx.provide('sandboxPolicy', { defaultMode: 'read-only', resolve: () => policy('read-only') })
  // The schema must resolve before direct construction (it fills timeoutMs & co).
  const executor = new WslBashExecutor(ctx, WslBashExecutor.Config({ sandbox: 'auto', probeTimeoutMs: 1000, ...config }))
  executor.internals = internals
  return { ctx, executor, spawns }
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

describe('WslBashExecutor argv', () => {
  it('passes the command base64-encoded through a decode pipeline with -d and --cd', async () => {
    const { executor, spawns } = setup({ wslDistro: 'Ubuntu' }, { probeBwrap: () => false, resolveWslPath: () => 'C:\\Windows\\System32\\wsl.exe' })
    const command = "echo 'a b' && echo $'c\td'"
    await executor.run(executor.resolve({ command, workdir: 'C:\\Users\\Alice\\Work' }))
    const argv = spawns[0]!.argv
    expect(argv.slice(0, 5)).toEqual(['C:\\Windows\\System32\\wsl.exe', '--cd', 'C:\\Users\\Alice\\Work', '-d', 'Ubuntu'])
    expect(argv[5]).toBe('--')
    expect(argv[6]).toBe('bash')
    expect(argv[7]).toBe('-c')
    expect(argv[8]).toBe(payload(command))
  })

  it('omits -d when no distro resolves', async () => {
    const { executor, spawns } = setup({}, { probeBwrap: () => false, resolveWslPath: () => 'wsl.exe', probeDistro: () => undefined })
    await executor.run(executor.resolve({ command: 'true' }))
    expect(spawns[0]!.argv[1]).toBe('--')
  })

  it('prepends the bwrap runner and profile when the bwrap probe passes', async () => {
    const { executor, spawns } = setup({ wslDistro: 'Ubuntu' }, { probeBwrap: () => true, resolveWslPath: () => 'wsl.exe' })
    await executor.run(executor.resolve({ command: 'true', workdir: 'C:\\w\\ws', sandboxPolicy: { mode: 'workspace-write', workspaceRoot: 'W:\\ws' } }))
    const argv = spawns[0]!.argv
    expect(argv.slice(5, 9)).toEqual(['--', 'bwrap', '--ro-bind', '/'])
    expect(argv).toContain('--tmpfs')
    expect(argv).toContain('/mnt/w/ws')
    expect(argv[argv.length - 2]).toBe('-c')
  })

  it('advertises no sandbox mode when the bwrap probe fails (auto)', () => {
    const { executor } = setup({}, { probeBwrap: () => false, resolveWslPath: () => 'wsl.exe' })
    expect(executor.sandboxMode).toBeUndefined()
  })

  it('fails loud at first use when explicit bwrap mode cannot probe', () => {
    const { executor } = setup({ sandbox: 'bwrap' }, { probeBwrap: () => false, resolveWslPath: () => 'wsl.exe' })
    expect(() => executor.sandboxMode).toThrow(/bwrap was not found/)
  })

  it('advertises the policy default mode under explicit bwrap with a working probe', () => {
    const { executor } = setup({ sandbox: 'bwrap' }, { probeBwrap: () => true, resolveWslPath: () => 'wsl.exe' })
    expect(executor.sandboxMode).toBe('read-only')
  })

  it('stamps sandbox facts on a bwrap background process settlement', async () => {
    const { executor } = setup({}, { probeBwrap: () => true, resolveWslPath: () => 'wsl.exe' })
    const proc = executor.start(executor.resolve({ command: 'sleep 0.01' }))
    await proc.done
    expect(proc.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
  })
})

describe('WslBashExecutor sandbox stances', () => {
  it('never probes or confines under sandbox: none', async () => {
    const { executor, spawns } = setup(
      { sandbox: 'none' },
      { probeBwrap: () => { throw new Error('must not probe') }, probeDistro: () => undefined, resolveWslPath: () => 'wsl.exe' },
    )
    expect(executor.sandboxMode).toBeUndefined()
    const result = await executor.run(executor.resolve({ command: 'true' }))
    expect(result.sandbox).toBeUndefined()
    expect(spawns[0]!.argv).toEqual(['wsl.exe', '--', 'bash', '-c', payload('true')])
  })

  it('fails loud at route time when WSL cannot be resolved', async () => {
    const { executor } = setup({}, { resolveWslPath: () => undefined })
    await expect(executor.run(executor.resolve({ command: 'true' }))).rejects.toThrow(/WSL was not found/)
  })

  it('runs unconfined under danger-full-access and reports the fact', async () => {
    const { executor, spawns } = setup({}, { probeBwrap: () => true, resolveWslPath: () => 'wsl.exe', probeDistro: () => undefined })
    const result = await executor.run(executor.resolve({ command: 'echo full', sandboxPolicy: policy('danger-full-access') }))
    expect(result.sandbox).toEqual({ mode: 'danger-full-access', denied: false })
    expect(spawns[0]!.argv).toEqual(['wsl.exe', '--', 'bash', '-c', payload('echo full')])
  })

  it('starts unconfined under danger-full-access without facts', async () => {
    const { executor, spawns } = setup({}, { probeBwrap: () => true, resolveWslPath: () => 'wsl.exe', probeDistro: () => undefined })
    const proc = executor.start(executor.resolve({ command: 'sleep 0.01', sandboxPolicy: policy('danger-full-access') }))
    await proc.done
    expect(spawns[0]!.argv).toEqual(['wsl.exe', '--', 'bash', '-c', payload('sleep 0.01')])
    expect(proc.sandbox).toBeUndefined()
  })

  it('starts unconfined with no facts when the auto bwrap probe fails', async () => {
    const { executor } = setup({}, { probeBwrap: () => false, resolveWslPath: () => 'wsl.exe', probeDistro: () => undefined })
    const proc = executor.start(executor.resolve({ command: 'sleep 0.01' }))
    await proc.done
    expect(proc.sandbox).toBeUndefined()
  })

  it('runs bwrap-confined with the default workdir and no distro', async () => {
    const { executor, spawns } = setup({}, { probeBwrap: () => true, resolveWslPath: () => 'wsl.exe', probeDistro: () => undefined })
    await executor.run(executor.resolve({ command: 'true' }))
    const argv = spawns[0]!.argv
    expect(argv.slice(1, 3)).toEqual(['--', 'bwrap'])
    expect(argv).not.toContain('--cd')
    expect(argv).not.toContain('-d')
  })

  it('passes a Linux workdir through --cd verbatim when it differs from the default', async () => {
    const { executor, spawns } = setup({}, { probeBwrap: () => false, resolveWslPath: () => 'wsl.exe', probeDistro: () => undefined })
    await executor.run(executor.resolve({ command: 'true', workdir: '/home/runner/work' }))
    expect(spawns[0]!.argv.slice(1, 3)).toEqual(['--cd', '/home/runner/work'])
  })

  it('fails loud when the workspace root cannot translate to a WSL path', async () => {
    const { executor } = setup({}, { probeBwrap: () => true, resolveWslPath: () => 'wsl.exe' })
    await expect(executor.run(executor.resolve({ command: 'true', sandboxPolicy: { mode: 'read-only', workspaceRoot: '/home/user/ws' } })))
      .rejects.toThrow(/unsupported Windows path/)
  })

  it('defaults a hand-built spec to the deployment sandbox policy', async () => {
    const { executor } = setup({}, { probeBwrap: () => true, resolveWslPath: () => 'wsl.exe', probeDistro: () => undefined })
    const result = await executor.run({
      command: 'x',
      workdir: process.cwd(),
      timeoutMs: 1000,
      stdoutMaxBytes: 64000,
      sandboxPolicy: undefined,
    })
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full' })
  })

  it('caches the bwrap verdict across sandboxMode reads and runs', async () => {
    let calls = 0
    const { executor } = setup({}, { probeBwrap: () => { calls += 1; return true }, resolveWslPath: () => 'wsl.exe', probeDistro: () => undefined })
    expect(executor.sandboxMode).toBe('read-only')
    expect(executor.sandboxMode).toBe('read-only')
    await executor.run(executor.resolve({ command: 'true' }))
    expect(calls).toBe(1)
  })

  it('caches the distro verdict across runs', async () => {
    let calls = 0
    const { executor, spawns } = setup({}, { probeBwrap: () => false, resolveWslPath: () => 'wsl.exe', probeDistro: () => { calls += 1; return 'Ubuntu' } })
    await executor.run(executor.resolve({ command: 'true' }))
    await executor.run(executor.resolve({ command: 'true' }))
    expect(calls).toBe(1)
    expect(spawns[1]!.argv).toContain('-d')
  })
})

describe('WslBashExecutor runner-failure facts', () => {
  function confinedSetup(outcome: (spec: SubprocessSpawnSpec, index: number) => {
    exitCode?: number | null
    stderr?: string
    spawnError?: Error
  }) {
    const ctx = new Context()
    const spawns: SubprocessSpawnSpec[] = []
    scriptedSubprocess(ctx, spawns, outcome)
    ctx.provide('sandboxPolicy', { defaultMode: 'read-only', resolve: () => policy('read-only') })
    const executor = new WslBashExecutor(ctx, WslBashExecutor.Config({ sandbox: 'auto', probeTimeoutMs: 1000 }))
    executor.internals = { probeBwrap: () => true, resolveWslPath: () => 'wsl.exe' }
    return { ctx, executor, spawns }
  }

  it('stamps runnerFailed on a bwrap foreground run matching the runner dialect', async () => {
    const { executor } = confinedSetup(() => ({ exitCode: 1, stderr: "bwrap: Can't create file" }))
    const result = await executor.run(executor.resolve({ command: 'true' }))
    expect(result.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full', runnerFailed: true })
  })

  it('stamps runnerFailed on a bwrap background process settlement', async () => {
    const { executor } = confinedSetup(() => ({ exitCode: 1, stderr: 'bwrap: boom' }))
    const proc = executor.start(executor.resolve({ command: 'sleep 0.01' }))
    await proc.done
    expect(proc.sandbox).toEqual({ mode: 'read-only', denied: false, enforcement: 'full', runnerFailed: true })
  })
})

/** A fake executable `wsl.exe` answering the probe invocations (POSIX shells only). */
function fakeWsl(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bash-wsl-probe-'))
  const wsl = join(dir, 'wsl.exe')
  writeFileSync(wsl, script, { mode: 0o755 })
  return wsl
}

const fakeWslUsable = process.platform !== 'win32'

describe.skipIf(!fakeWslUsable)('WslBashExecutor real probes (fake wsl.exe)', () => {
  it('resolves the first distro and probes bwrap through the real spawnSync path', async () => {
    const wsl = fakeWsl('#!/bin/sh\nif [ "$1" = "-l" ]; then echo Ubuntu; exit 0; fi\nexit 0\n')
    const { executor, spawns } = setup({}, { resolveWslPath: () => wsl })
    const result = await executor.run(executor.resolve({ command: 'true', sandboxPolicy: policy('workspace-write') }))
    expect(result.sandbox).toEqual({ mode: 'workspace-write', denied: false, enforcement: 'full' })
    const argv = spawns[0]!.argv
    expect(argv[0]).toBe(wsl)
    expect(argv).toContain('-d')
    expect(argv).toContain('Ubuntu')
  })

  it('falls back unconfined when the real probes report failure', async () => {
    const wsl = fakeWsl('#!/bin/sh\nexit 1\n')
    const { executor, spawns } = setup({}, { resolveWslPath: () => wsl })
    const result = await executor.run(executor.resolve({ command: 'true' }))
    expect(result.sandbox).toBeUndefined()
    expect(spawns[0]!.argv[0]).toBe(wsl)
    expect(spawns[0]!.argv[1]).toBe('--')
  })

  it('treats a probing wsl.exe that times out as unavailable', async () => {
    const wsl = fakeWsl('#!/bin/sh\nsleep 10\n')
    const { executor, spawns } = setup({ probeTimeoutMs: 300 }, { resolveWslPath: () => wsl })
    const result = await executor.run(executor.resolve({ command: 'true' }))
    expect(result.sandbox).toBeUndefined()
    expect(spawns[0]!.argv[0]).toBe(wsl)
    expect(spawns[0]!.argv[1]).toBe('--')
  })

  it('resolves the bare wsl command through the default path when no internals are installed', async () => {
    // No internals at all: the real resolver runs and, on POSIX hosts, the
    // bare `wsl` command resolves, so both spawnSync probes fail with ENOENT
    // and the command runs unconfined without a distro.
    const { executor, spawns } = setup({})
    const result = await executor.run(executor.resolve({ command: 'true' }))
    expect(result.sandbox).toBeUndefined()
    expect(spawns[0]!.argv[0]).toBe('wsl')
    expect(spawns[0]!.argv[1]).toBe('--')
  })
})

const hasRealWsl = process.platform === 'win32' && resolveWslPath(undefined, process.env, process.platform) !== undefined

describe.skipIf(!hasRealWsl)('WslBashExecutor real WSL smoke', () => {
  it('runs a command through the real wsl.exe', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
    ctx.provide('sandboxPolicy', { defaultMode: 'read-only', resolve: () => policy('read-only') })
    const executor = new WslBashExecutor(ctx, WslBashExecutor.Config({ sandbox: 'none', probeTimeoutMs: 30_000 }))
    const result = await executor.run(executor.resolve({ command: 'echo ok' }))
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('ok\n')
  })
})
