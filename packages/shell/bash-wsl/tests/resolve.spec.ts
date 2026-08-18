import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { candidateWslPaths, parseWslDistroList, resolveWslPath, toWslPath } from '../src/resolve.ts'

describe('candidateWslPaths', () => {
  it('probes System32 before PATH entries', () => {
    // Expected values use join() so the assertion is separator-agnostic on
    // every host (the implementation resolves through the same join).
    expect(candidateWslPaths({ SystemRoot: 'C:\\Windows', PATH: 'C:\\tools' })).toEqual([
      join('C:\\Windows', 'System32', 'wsl.exe'),
      join('C:\\tools', 'wsl.exe'),
    ])
  })
})

describe('resolveWslPath', () => {
  it('trusts an explicit config value verbatim', () => {
    expect(resolveWslPath('D:\\wsl\\wsl.exe', {}, 'win32')).toBe('D:\\wsl\\wsl.exe')
  })

  it('returns the first existing candidate on win32 and undefined otherwise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-bash-wsl-resolve-'))
    // The first probed candidate under SystemRoot\System32.
    const system32 = join(dir, 'System32')
    mkdirSync(system32, { recursive: true })
    const wsl = join(system32, 'wsl.exe')
    writeFileSync(wsl, '')
    expect(resolveWslPath(undefined, { SystemRoot: dir, PATH: '' }, 'win32')).toBe(wsl)
    expect(resolveWslPath(undefined, { SystemRoot: 'C:\\missing', PATH: '' }, 'win32')).toBeUndefined()
  })

  it('returns the bare wsl command on non-win32 platforms', () => {
    expect(resolveWslPath(undefined, {}, 'linux')).toBe('wsl')
  })

  it('falls through an empty configured path to platform probing', () => {
    expect(resolveWslPath('', { SystemRoot: 'C:\\missing', PATH: '' }, 'win32')).toBeUndefined()
  })

  it('accepts a link-shaped candidate that stat cannot resolve', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-bash-wsl-resolve-link-'))
    const system32 = join(dir, 'System32')
    mkdirSync(system32, { recursive: true })
    // A dangling symlink reproduces the Store-app alias split (lstat sees a
    // link where stat would fail) on every platform.
    const link = join(system32, 'wsl.exe')
    symlinkSync(join(dir, 'no-such-target.exe'), link)
    expect(resolveWslPath(undefined, { SystemRoot: dir, PATH: '' }, 'win32')).toBe(link)
  })

  it('skips a directory candidate and keeps probing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-bash-wsl-resolve-dir-'))
    const system32 = join(dir, 'System32')
    mkdirSync(system32, { recursive: true })
    // The first candidate slot is a directory, so it must be skipped.
    mkdirSync(join(system32, 'wsl.exe'), { recursive: true })
    const pathDir = mkdtempSync(join(tmpdir(), 'dsh-bash-wsl-resolve-path-'))
    const wsl = join(pathDir, 'wsl.exe')
    writeFileSync(wsl, '')
    expect(resolveWslPath(undefined, { SystemRoot: dir, PATH: pathDir }, 'win32')).toBe(wsl)
  })
})

describe('parseWslDistroList', () => {
  it('parses -l -q output including the UTF-16LE null-byte interleaving', () => {
    // wsl.exe writes UTF-16LE when stdout is redirected; the \0 bytes must be stripped.
    expect(parseWslDistroList('U\u0000b\u0000u\u0000n\u0000t\u0000u\u0000\r\u0000\n\u0000')).toEqual(['Ubuntu'])
  })

  it('strips quotes, blank lines and header markers', () => {
    expect(parseWslDistroList('\r\n"Ubuntu-22.04"\r\nUbuntu\r\n')).toEqual(['Ubuntu-22.04', 'Ubuntu'])
  })
})

describe('toWslPath', () => {
  it('converts drive-letter paths to /mnt/<drive> form', () => {
    expect(toWslPath('C:\\Users\\Alice\\Work')).toBe('/mnt/c/Users/Alice/Work')
    expect(toWslPath('D:/data')).toBe('/mnt/d/data')
  })

  it('fails loud for unsupported path forms', () => {
    expect(() => toWslPath('\\server\\share\\x')).toThrow(/unsupported Windows path/)
    expect(() => toWslPath('relative')).toThrow(/unsupported Windows path/)
  })
})
