import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { SHELL_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-shell'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { ShellSelectExecutor } from '../src/index.ts'
import { SHELL_BACKEND_UNAVAILABLE } from '../src/index.ts'
import type { BackendExecutor } from '../src/index.ts'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'

function fakeBackend(name: string, mode?: 'read-only'): BackendExecutor & { calls: Array<{ kind: string; spec?: ShellExecSpec }> } {
  const calls: Array<{ kind: string; spec?: ShellExecSpec }> = []
  const backend: BackendExecutor = {
    sandboxMode: mode,
    resolve: (request: ShellExecRequest) => ({
      command: request.command,
      workdir: request.workdir ?? process.cwd(),
      timeoutMs: 1000,
      stdoutMaxBytes: 64_000,
      sandboxPolicy: undefined,
      ...(request.shell !== undefined ? { shellBackend: request.shell } : {}),
    }),
    run: async (spec: ShellExecSpec): Promise<ShellRunResult> => {
      calls.push({ kind: 'run', spec })
      return { exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: spec.timeoutMs, stdout: { text: name, truncated: false }, stderr: { text: '', truncated: false } }
    },
    start: (spec: ShellExecSpec): ShellProcess => {
      calls.push({ kind: 'start', spec })
      return { status: 'running', exitCode: null, signal: null, done: Promise.resolve(), readOutput: () => ({ delta: '', lossy: false }), kill: () => false }
    },
  }
  return Object.assign(backend, { calls })
}

function setup(config: ConstructorParameters<typeof ShellSelectExecutor>[1] = {}) {
  const ctx = new Context()
  const a = fakeBackend('a')
  const b = fakeBackend('b', 'read-only')
  // The schema must resolve before direct construction (nested partition defaults).
  const executor = new ShellSelectExecutor(ctx, ShellSelectExecutor.Config(config))
  executor.internals = { factories: { a: () => a, b: () => b } }
  return { ctx, executor, a, b }
}

function policy(): SandboxExecutionPolicy {
  return { mode: 'read-only', workspaceRoot: process.cwd() }
}

describe('ShellSelectExecutor', () => {
  it('routes resolve/run to the configured default backend and stamps shellBackend', async () => {
    const { executor, a } = setup({ backends: ['a'], default: 'a' })
    const spec = executor.resolve({ command: 'echo x' })
    expect(spec.shellBackend).toBe('a')
    const result = await executor.run(spec)
    expect(result.stdout.text).toBe('a')
    expect(a.calls[0]!.kind).toBe('run')
  })

  it('routes explicit request.shell to the named backend', async () => {
    const { executor, b } = setup({ backends: ['a', 'b'], default: 'a' })
    const spec = executor.resolve({ command: 'echo x', shell: 'b' })
    expect(spec.shellBackend).toBe('b')
    await executor.run(spec)
    expect(b.calls[0]!.kind).toBe('run')
  })

  it('fails loud with SHELL_BACKEND_UNAVAILABLE for unknown or disabled backends', () => {
    const { executor } = setup({ backends: ['a'], default: 'a' })
    expect(() => executor.resolve({ command: 'x', shell: 'nope' })).toThrow(HarnessError)
    try {
      executor.resolve({ command: 'x', shell: 'nope' })
      throw new Error('must not reach')
    } catch (error) {
      expect((error as HarnessError).code).toBe(SHELL_BACKEND_UNAVAILABLE)
    }
  })

  it('reports the first declared backend sandboxMode', () => {
    const { executor } = setup({ backends: ['a', 'b'], default: 'a' })
    expect(executor.sandboxMode).toBe('read-only')
  })

  it('applies nested backend schema defaults to absent partitions', () => {
    const { executor } = setup({ backends: ['a'] })
    expect(executor.config.gitBash.timeoutMs).toBe(120_000)
    expect(executor.config.pwsh.pwshPath).toBeUndefined()
  })

  it('delegates start to the routed backend', async () => {
    const { executor, b } = setup({ backends: ['a', 'b'], default: 'b' })
    const proc = executor.start(executor.resolve({ command: 'sleep 1' }))
    expect(proc.status).toBe('running')
    expect(b.calls[0]!.kind).toBe('start')
  })

  it('routes a spec without a shellBackend stamp to the configured default', async () => {
    const { executor, a } = setup({ backends: ['a'], default: 'a' })
    const spec: ShellExecSpec = { command: 'echo x', workdir: process.cwd(), timeoutMs: 1000, stdoutMaxBytes: 64_000, sandboxPolicy: undefined }
    const result = await executor.run(spec)
    expect(result.stdout.text).toBe('a')
    expect(a.calls[0]!.kind).toBe('run')
  })

  it('starts a spec without a shellBackend stamp on the configured default', () => {
    const { executor, a } = setup({ backends: ['a'], default: 'a' })
    const spec: ShellExecSpec = { command: 'echo x', workdir: process.cwd(), timeoutMs: 1000, stdoutMaxBytes: 64_000, sandboxPolicy: undefined }
    const proc = executor.start(spec)
    expect(proc.status).toBe('running')
    expect(a.calls[0]!.kind).toBe('start')
  })

  it('advertises no sandbox mode when no backend declares one', () => {
    const { executor } = setup({ backends: ['a'], default: 'a' })
    expect(executor.sandboxMode).toBeUndefined()
  })

  it('fails loud for an enabled name with no factory', () => {
    const { executor } = setup({ backends: ['nope'], default: 'nope' })
    expect(() => executor.resolve({ command: 'x' })).toThrow(/unknown backend "nope"/)
  })

  it('fails loud with SHELL_BACKEND_UNAVAILABLE when no backends are enabled', () => {
    const { executor } = setup({ backends: [], default: 'a' })
    expect(() => executor.resolve({ command: 'x' })).toThrow(HarnessError)
  })

  it('constructs the default backends through their real factories', async () => {
    const ctx = new Context()
    // The selector's static inject list must be satisfiable; nothing here
    // spawns or confines, so the stubs only need to exist. Mounting through
    // ctx.plugin (as the Loader does) loads the backend child fibers before
    // their inherited Service registration runs.
    ctx.provide('subprocess', {
      spawn: () => {
        throw new Error('shell-select default-factory spec must not spawn')
      },
    })
    ctx.provide('sandbox', {
      confine: (argv: readonly string[]) => ({ argv: [...argv], enforcement: 'full' as const, denialSignatures: [], runnerFailureRules: [] }),
    })
    ctx.provide('sandboxPolicy', { defaultMode: 'read-only', resolve: () => policy() })
    await ctx.plugin(ShellSelectExecutor, ShellSelectExecutor.Config({ backends: ['git-bash', 'wsl-bash', 'pwsh'], default: 'pwsh' }))
    const executor = ctx.shell as ShellSelectExecutor
    const spec = executor.resolve({ command: 'echo hi' })
    expect(spec.shellBackend).toBe('pwsh')
    // The real pwsh backend stamped its resolved sandbox policy; the real
    // git-bash/wsl-bash backends constructed without probing (lazy probes).
    expect(spec.sandboxPolicy?.mode).toBe('read-only')
    await ctx.fiber.dispose()
  })
})

/** The smallest real provider: one in-memory document, always writable (bash-local pattern). */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

async function bootWithSettings(config: ConstructorParameters<typeof ShellSelectExecutor>[1] = {}) {
  const ctx = new Context()
  // The selector's static inject list must be satisfiable; nothing in these
  // tests spawns or confines, so the stubs only need to exist.
  ctx.provide('subprocess', {
    spawn: () => {
      throw new Error('shell-select settings spec must not spawn')
    },
  })
  ctx.provide('sandbox', {
    confine: (argv: readonly string[]) => ({ argv: [...argv], enforcement: 'full' as const, denialSignatures: [], runnerFailureRules: [] }),
  })
  ctx.provide('sandboxPolicy', { defaultMode: 'read-only', resolve: () => policy() })
  const settingsFiber = ctx.plugin(MemorySettings)
  await settingsFiber.await()
  const executorFiber = ctx.plugin(ShellSelectExecutor, ShellSelectExecutor.Config(config))
  await executorFiber.await()
  return { ctx, settingsFiber, executorFiber, executor: ctx.shell as ShellSelectExecutor }
}

describe('ShellSelectExecutor settings section', () => {
  it('resolves the user layer over the composition entry and rebuilds backends on change', async () => {
    const bench = await bootWithSettings({ default: 'pwsh' })
    expect(bench.executor.config.default).toBe('pwsh')

    await bench.ctx.settings.update(SHELL_SETTINGS_NAMESPACE, { default: 'git-bash' })

    expect(bench.executor.config.default).toBe('git-bash')
    // The onChange rebuild constructed the real backends from the new source.
    expect(bench.executor.resolve({ command: 'echo hi' }).shellBackend).toBe('git-bash')
    await bench.ctx.fiber.dispose()
  })

  it('refuses a stored partition the constructor would have rejected', async () => {
    const bench = await bootWithSettings()

    await expect(bench.ctx.settings.update(SHELL_SETTINGS_NAMESPACE, { gitBash: { timeoutMs: 0 } }))
      .rejects.toThrow(/positive finite/)

    expect(bench.executor.config.gitBash.timeoutMs).toBe(120_000)
    await bench.ctx.fiber.dispose()
  })

  it('falls back to the composition entry when the settings provider detaches', async () => {
    const bench = await bootWithSettings({ default: 'pwsh' })
    await bench.ctx.settings.update(SHELL_SETTINGS_NAMESPACE, { default: 'git-bash' })
    expect(bench.executor.config.default).toBe('git-bash')

    await bench.settingsFiber.dispose()

    expect(bench.executor.config.default).toBe('pwsh')
    await bench.ctx.fiber.dispose()
  })

  it('keeps the composition entry when no settings provider is mounted', async () => {
    const ctx = new Context()
    ctx.provide('subprocess', {
      spawn: () => {
        throw new Error('shell-select settings spec must not spawn')
      },
    })
    ctx.provide('sandbox', {
      confine: (argv: readonly string[]) => ({ argv: [...argv], enforcement: 'full' as const, denialSignatures: [], runnerFailureRules: [] }),
    })
    ctx.provide('sandboxPolicy', { defaultMode: 'read-only', resolve: () => policy() })
    await ctx.plugin(ShellSelectExecutor, ShellSelectExecutor.Config({ default: 'pwsh' }))

    expect((ctx.shell as ShellSelectExecutor).config.default).toBe('pwsh')
    await ctx.fiber.dispose()
  })

  it('releases the shell namespace when the executor unloads', async () => {
    const bench = await bootWithSettings()
    expect(bench.ctx.settings.describe().map(row => String(row.ns))).toContain('shell')

    await bench.executorFiber.dispose()

    expect(bench.ctx.settings.describe().map(row => String(row.ns))).not.toContain('shell')
    await bench.ctx.fiber.dispose()
  })
})
