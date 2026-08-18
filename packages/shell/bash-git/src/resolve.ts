/**
 * Git Bash executable resolution for the bash-git executor, dependency-free
 * and parameterized (env/platform) so resolution is a pure function of its
 * inputs on every platform — the twin of dsh-pwsh-local's resolvePwshPath.
 * @module @deepseek-ai/dsh-bash-git/resolve
 */

import { lstatSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Well-known Git for Windows install locations plus PATH entries.
 * @param env - the environment to probe; defaults to the process environment.
 * @returns candidate `bash.exe` paths in resolution order.
 */
export function candidateBashPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
  const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const candidates = [
    join(programFiles, 'Git', 'bin', 'bash.exe'),
    join(programFiles, 'Git', 'usr', 'bin', 'bash.exe'),
    join(programFilesX86, 'Git', 'bin', 'bash.exe'),
  ]
  for (const entry of (env.PATH ?? '').split(';')) {
    const trimmed = entry.trim().replace(/^"|"$/g, '')
    if (trimmed.length === 0) continue
    candidates.push(join(trimmed, 'bash.exe'))
  }
  return candidates
}

function candidateExists(candidate: string): boolean {
  try {
    const stat = lstatSync(candidate)
    return stat.isFile() || stat.isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Resolve the Git Bash executable this executor spawns. Returns undefined on
 * win32 when no candidate exists (the executor turns that into a loud
 * route-time error naming the probes); non-win32 hosts resolve a bare
 * `bash` for PATH resolution, mirroring resolvePwshPath.
 * @param configured - an explicit `bashPath` config value, trusted as-is.
 * @param env - the environment to probe on Windows; defaults to the process environment.
 * @param platform - the platform to resolve for; defaults to the process platform.
 * @returns the first existing well-known location on win32, else `bash`, else undefined.
 */
export function resolveBashPath(
  configured?: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (configured !== undefined && configured.length > 0) return configured
  if (platform === 'win32') {
    for (const candidate of candidateBashPaths(env)) {
      if (candidateExists(candidate)) return candidate
    }
    return undefined
  }
  return 'bash'
}
