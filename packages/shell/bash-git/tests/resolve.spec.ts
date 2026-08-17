import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { candidateBashPaths, resolveBashPath } from '../src/resolve.ts'

describe('candidateBashPaths', () => {
  it('probes Program Files installs before PATH entries', () => {
    const env = { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', PATH: 'C:\\tools' }
    const candidates = candidateBashPaths(env)
    // Expected values use join() so the assertion is separator-agnostic on
    // every host (the implementation resolves through the same join).
    expect(candidates).toEqual([
      join('C:\\PF', 'Git', 'bin', 'bash.exe'),
      join('C:\\PF', 'Git', 'usr', 'bin', 'bash.exe'),
      join('C:\\PF86', 'Git', 'bin', 'bash.exe'),
      join('C:\\tools', 'bash.exe'),
    ])
  })

  it('skips empty and quoted PATH entries', () => {
    const env = { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', PATH: ';"C:\\quoted dir";' }
    expect(candidateBashPaths(env)[3]).toBe(join('C:\\quoted dir', 'bash.exe'))
  })

  it('uses stable Windows roots when the environment omits overrides', () => {
    const candidates = candidateBashPaths({})
    expect(candidates).toEqual([
      join('C:\\Program Files', 'Git', 'bin', 'bash.exe'),
      join('C:\\Program Files', 'Git', 'usr', 'bin', 'bash.exe'),
      join('C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    ])
  })
})

describe('resolveBashPath', () => {
  it('trusts an explicit config value verbatim', () => {
    expect(resolveBashPath('D:\\custom\\bash.exe', {}, 'win32')).toBe('D:\\custom\\bash.exe')
  })

  it('returns the first existing well-known install on win32', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-bash-git-resolve-'))
    // The first probed well-known location under ProgramFiles.
    const bash = join(dir, 'Git', 'bin', 'bash.exe')
    mkdirSync(join(dir, 'Git', 'bin'), { recursive: true })
    writeFileSync(bash, '')
    expect(resolveBashPath(undefined, { ProgramFiles: dir, 'ProgramFiles(x86)': join(dir, 'x86'), PATH: '' }, 'win32'))
      .toBe(bash)
  })

  it('returns undefined on win32 when nothing exists', () => {
    expect(resolveBashPath(undefined, { ProgramFiles: 'C:\\missing', 'ProgramFiles(x86)': 'C:\\missing-x86', PATH: '' }, 'win32'))
      .toBeUndefined()
  })

  it('falls through an empty configured path to platform probing', () => {
    expect(resolveBashPath('', { ProgramFiles: 'C:\\missing', 'ProgramFiles(x86)': 'C:\\missing-x86', PATH: '' }, 'win32'))
      .toBeUndefined()
  })

  it('accepts a link-shaped candidate that stat cannot resolve', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-bash-git-resolve-link-'))
    const store = join(dir, 'store')
    mkdirSync(store, { recursive: true })
    // A dangling symlink reproduces the Store-app alias split (lstat sees a
    // link where stat would fail) on every platform.
    const link = join(store, 'bash.exe')
    symlinkSync(join(dir, 'no-such-target.exe'), link)
    expect(resolveBashPath(undefined, { ProgramFiles: join(dir, 'missing'), 'ProgramFiles(x86)': join(dir, 'x86'), PATH: store }, 'win32'))
      .toBe(link)
  })

  it('skips a directory candidate and keeps probing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-bash-git-resolve-dir-'))
    const install = join(dir, 'Git', 'bin')
    mkdirSync(install, { recursive: true })
    // The first candidate slot is a directory, so it must be skipped.
    mkdirSync(join(install, 'bash.exe'), { recursive: true })
    const second = join(dir, 'Git', 'usr', 'bin', 'bash.exe')
    mkdirSync(join(dir, 'Git', 'usr', 'bin'), { recursive: true })
    writeFileSync(second, '')
    expect(resolveBashPath(undefined, { ProgramFiles: dir, 'ProgramFiles(x86)': join(dir, 'x86'), PATH: '' }, 'win32'))
      .toBe(second)
  })

  it('returns the bare bash command on non-win32 platforms', () => {
    expect(resolveBashPath(undefined, {}, 'linux')).toBe('bash')
    expect(resolveBashPath(undefined, {}, 'darwin')).toBe('bash')
  })
})
