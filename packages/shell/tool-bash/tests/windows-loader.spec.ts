/**
 * REAL-composition tier (packages/AGENTS.md): boot the examples-owned
 * tool-bash-windows Loader fixture as a subprocess through the same app/boot
 * path a deployment uses, execute real foreground git_bash and wsl_bash
 * commands through the tool registry, and assert the assembled model-visible
 * surface: both schemas and their dialect descriptions, plus the rendered
 * results of whichever backends this host has. Self-skips on hosts with
 * neither Git Bash nor WSL.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { resolveBashPath } from '../../bash-git/src/resolve.ts'
import { resolveWslPath } from '../../bash-wsl/src/resolve.ts'

// The probes follow each executor's own resolution (Program Files installs on
// Windows are found even when bare `bash`/`wsl` are not on PATH).
const bashPath = resolveBashPath()
const hasGitBash = bashPath !== undefined && spawnSync(bashPath, ['-c', 'exit 0']).status === 0
const wslPath = resolveWslPath()
const hasWsl = wslPath !== undefined && spawnSync(wslPath, ['--status']).status === 0

const driver = fileURLToPath(new URL(
  '../../../../examples/acp-agent/tests/fixtures/shell/tool-bash-windows/driver.ts',
  import.meta.url,
))
const configPath = fileURLToPath(new URL(
  '../../../../examples/acp-agent/tests/fixtures/shell/tool-bash-windows/cordis.yml',
  import.meta.url,
))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

interface BashWindowsLoaderReport {
  gitBashSchemaPresent: boolean
  wslBashSchemaPresent: boolean
  gitBashDescriptionHasDialect: boolean
  wslBashDescriptionHasDialect: boolean
  gitBashRan: boolean
  wslBashRan: boolean
  gitBashText: string
  wslText: string
}

describe.skipIf(!hasGitBash && !hasWsl)('git_bash/wsl_bash through a real Loader composition', () => {
  it('registers both bash-family surfaces and renders real results for available backends', async () => {
    let report: BashWindowsLoaderReport | undefined
    const { stderr } = await runLoaderSmoke({
      label: 'tool-bash-windows loader smoke',
      tempDirPrefix: 'tool-bash-windows-loader-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      inspect: async (cwd) => {
        report = JSON.parse(await readFile(join(cwd, 'bash-windows-loader-report.json'), 'utf8')) as BashWindowsLoaderReport
      },
    })
    expect(stderr).not.toContain('UNHANDLED')
    expect(report).toBeDefined()
    expect(report).toMatchObject({
      gitBashSchemaPresent: true,
      wslBashSchemaPresent: true,
      gitBashDescriptionHasDialect: true,
      wslBashDescriptionHasDialect: true,
    })
    if (hasGitBash) {
      expect(report?.gitBashRan).toBe(true)
      expect(report?.gitBashText).toContain('git-bash-ok')
    } else {
      expect(report?.gitBashRan).toBe(false)
    }
    if (hasWsl) {
      expect(report?.wslBashRan).toBe(true)
      expect(report?.wslText).toContain('wsl-ok')
    } else {
      expect(report?.wslBashRan).toBe(false)
    }
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
