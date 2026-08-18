/**
 * The Git Bash (MSYS) tool instance: routes `request.shell` to the
 * 'git-bash' backend so a selector executor can serve it beside pwsh and WSL.
 * @module @deepseek-ai/dsh-tool-bash/git-bash
 */

import { defineShellTool } from './factory.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    git_bash: 'git_bash'
  }
}

/** The Git Bash tool: routes request.shell to the 'git-bash' backend. */
const tool = defineShellTool({ toolName: 'git_bash', shell: 'git-bash', dialect: 'msys' })

export const name = tool.name
export const inject = tool.inject
export const Config = tool.Config
export const apply = tool.apply
