#!/usr/bin/env node
/**
 * Test driver: boot the tool-bash-windows Loader composition — the real app
 * boot path, the real shell-select executor over real git-bash/wsl-bash/pwsh
 * backends, and the git_bash/wsl_bash tools — execute one real foreground
 * command through each bash-family tool whose backend exists on this host,
 * and persist the observed model-visible surface to
 * `./bash-windows-loader-report.json` for the package spec's inspect step.
 */

import { spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { resolveBashPath } from '@deepseek-ai/dsh-bash-git/src/resolve.ts'
import { resolveWslPath } from '@deepseek-ai/dsh-bash-wsl/src/resolve.ts'
import { CallId } from '@deepseek-ai/dsh-llm'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('tool-bash-windows driver requires a config path')

// The probes follow each executor's own resolution (Program Files installs on
// Windows are found even when bare `bash`/`wsl` are not on PATH).
const bashPath = resolveBashPath()
const hasGitBash = bashPath !== undefined && spawnSync(bashPath, ['-c', 'exit 0']).status === 0
const wslPath = resolveWslPath()
const hasWsl = wslPath !== undefined && spawnSync(wslPath, ['--status']).status === 0

const ctx = await boot('tool-bash-windows-loader-smoke', resolveConfigPath(configPath, undefined))
try {
  const schemas = ctx.tools.schemas()
  const gitBashSchema = schemas.find(tool => tool.name === 'git_bash')
  if (gitBashSchema === undefined) throw new Error('git_bash tool not registered by the composition')
  const wslBashSchema = schemas.find(tool => tool.name === 'wsl_bash')
  if (wslBashSchema === undefined) throw new Error('wsl_bash tool not registered by the composition')

  async function runTool(name: string, command: string, callId: string): Promise<string> {
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId(callId),
      name,
      arguments: { command, description: `loader ${name} foreground` },
    })
    return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
  }

  const gitBashText = hasGitBash ? await runTool('git_bash', 'echo git-bash-ok', 'loader-git-bash') : ''
  const wslText = hasWsl ? await runTool('wsl_bash', 'echo wsl-ok', 'loader-wsl-bash') : ''

  await writeFile('./bash-windows-loader-report.json', JSON.stringify({
    gitBashSchemaPresent: true,
    wslBashSchemaPresent: true,
    gitBashDescriptionHasDialect: gitBashSchema.description.includes('Git Bash'),
    wslBashDescriptionHasDialect: wslBashSchema.description.includes('WSL'),
    gitBashRan: hasGitBash,
    wslBashRan: hasWsl,
    // Normalize each shell's platform line endings (CRLF on Windows, LF in WSL).
    gitBashText: gitBashText.replace(/\r\n/g, '\n'),
    wslText: wslText.replace(/\r\n/g, '\n'),
  }))
} finally {
  await ctx.fiber.dispose()
}
