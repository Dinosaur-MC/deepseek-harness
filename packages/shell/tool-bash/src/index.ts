/**
 * The POSIX bash tool instance built by the shared shell-tool factory. Its
 * tool contract is unchanged: no `shell` field, so a selector executor
 * routes it to its configured default; single-backend compositions never
 * notice the field.
 * @module @deepseek-ai/dsh-tool-bash
 */

import { defineShellTool, type Config as ShellToolConfig } from './factory.ts'

/** The POSIX bash tool (unchanged contract). */
const bashTool = defineShellTool({ toolName: 'bash', dialect: 'posix' })

export const name = bashTool.name
export const inject = bashTool.inject
export const Config = bashTool.Config
export const apply = bashTool.apply
export { defineShellTool } from './factory.ts'
export type { ShellDialect, ShellToolDefinition } from './factory.ts'
/** The instance config type, kept exportable for typed plugin-forwarding consumers. */
export type Config = ShellToolConfig
