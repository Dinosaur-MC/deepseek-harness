/**
 * The WSL bash tool instance: routes `request.shell` to the 'wsl-bash'
 * backend so a selector executor can serve it beside pwsh and Git Bash.
 * @module @deepseek-ai/dsh-tool-bash/wsl-bash
 */

import { defineShellTool } from './factory.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    wsl_bash: 'wsl_bash'
  }
}

/** The WSL bash tool: routes request.shell to the 'wsl-bash' backend. */
const tool = defineShellTool({ toolName: 'wsl_bash', shell: 'wsl-bash', dialect: 'wsl' })

export const name = tool.name
export const inject = tool.inject
export const Config = tool.Config
export const apply = tool.apply
