/**
 * WSL executable and distro resolution for the bash-wsl executor, dependency-free
 * and parameterized (env/platform) so resolution is a pure function of its
 * inputs on every platform — the twin of dsh-bash-git's resolveBashPath and
 * dsh-pwsh-local's resolvePwshPath.
 * @module @deepseek-ai/dsh-bash-wsl/resolve
 */

import { lstatSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Well-known WSL executable locations: System32 (the shipped wsl.exe) plus
 * PATH entries.
 * @param env - the environment to probe; defaults to the process environment.
 * @returns candidate `wsl.exe` paths in resolution order.
 */
export function candidateWslPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const systemRoot = env.SystemRoot ?? 'C:\\Windows'
  const candidates = [join(systemRoot, 'System32', 'wsl.exe')]
  for (const entry of (env.PATH ?? '').split(';')) {
    const trimmed = entry.trim().replace(/^"|"$/g, '')
    if (trimmed.length === 0) continue
    candidates.push(join(trimmed, 'wsl.exe'))
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
 * Resolve the wsl.exe executable this executor spawns. Returns undefined on
 * win32 when no candidate exists (the executor turns that into a loud
 * route-time error naming the probes); non-win32 hosts resolve a bare
 * `wsl` for PATH resolution, mirroring resolvePwshPath.
 * @param configured - an explicit `wslPath` config value, trusted as-is.
 * @param env - the environment to probe on Windows; defaults to the process environment.
 * @param platform - the platform to resolve for; defaults to the process platform.
 * @returns the first existing well-known location on win32, else `wsl`, else undefined.
 */
export function resolveWslPath(
  configured?: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (configured !== undefined && configured.length > 0) return configured
  if (platform === 'win32') {
    for (const candidate of candidateWslPaths(env)) {
      if (candidateExists(candidate)) return candidate
    }
    return undefined
  }
  return 'wsl'
}

/**
 * Parse `wsl -l -q` output into distro names. wsl.exe writes UTF-16LE with
 * null-byte interleaving when stdout is redirected, so NUL bytes are stripped
 * before splitting; surrounding quotes and blank lines are dropped.
 * @param output - raw `-l -q` stdout.
 * @returns distro names in output order.
 */
export function parseWslDistroList(output: string): string[] {
  const distros: string[] = []
  for (const raw of output.replace(/\0/g, '').split(/\r?\n/)) {
    const line = raw.trim().replace(/^"|"$/g, '')
    if (line.length === 0) continue
    distros.push(line)
  }
  return distros
}

/**
 * Convert a Windows drive-letter path to the WSL /mnt/<drive>/... form used
 * as the bwrap workspace root inside the distro. Anything without a
 * drive-letter form fails loud: wsl.exe's own `--cd` translation covers
 * workdirs, but the bwrap profile needs an explicit Linux-side root.
 * @param winPath - the Windows path to convert.
 * @returns the Linux-side path.
 * @throws Error when the path has no drive-letter form.
 */
export function toWslPath(winPath: string): string {
  const match = /^([A-Za-z]):[\\/](.+)$/.exec(winPath)
  if (match === null) {
    throw new Error(`unsupported Windows path: ${winPath}`)
  }
  const drive = match[1]
  const rest = match[2]
  /* v8 ignore next -- the regex guarantees both captures whenever it matches */
  if (drive === undefined || rest === undefined) throw new Error(`unsupported Windows path: ${winPath}`)
  return `/mnt/${drive.toLowerCase()}/${rest.replaceAll('\\', '/')}`
}
