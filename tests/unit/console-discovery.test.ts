import { afterEach, describe, expect, it, vi } from 'vitest'
import { Ignitor } from '../../src/Ignitor.js'

const APP_ROOT = new URL('../fixtures/console-app/', import.meta.url)

function captureOutput(): { out: () => string; restore: () => void } {
  let buffer = ''
  const write = (chunk: string | Uint8Array): boolean => {
    buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
    return true
  }
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(write)
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(write)
  return {
    out: () => buffer,
    restore: () => {
      stdout.mockRestore()
      stderr.mockRestore()
    },
  }
}

describe('ConsoleKernel discovery', () => {
  const originalExitCode = process.exitCode

  afterEach(() => {
    process.exitCode = originalExitCode
    vi.restoreAllMocks()
  })

  it('runs a command found in the app commands/ directory', async () => {
    const captured = captureOutput()
    await new Ignitor(APP_ROOT).console().handle(['greet', 'World'])
    const output = captured.out()
    captured.restore()

    expect(output).toContain('Hello World')
  })

  it('discovers commands in subdirectories and skips underscore files', async () => {
    const captured = captureOutput()
    await new Ignitor(APP_ROOT).console().handle(['list'])
    const output = captured.out()
    captured.restore()

    expect(output).toContain('greet')
    expect(output).toContain('deep:command')
    expect(output).not.toContain('_helper')
  })

  it('warns about a module of the wrong shape instead of aborting', async () => {
    const captured = captureOutput()
    await new Ignitor(APP_ROOT).console().handle(['greet', 'World'])
    const output = captured.out()
    captured.restore()

    // broken.ts exports no command: reported, but `greet` still ran.
    expect(output).toContain('Skipped broken.ts')
    expect(output).toContain('Hello World')
  })

  it('does not boot the application for a command that did not ask', async () => {
    const ignitor = new Ignitor(APP_ROOT)
    const start = vi.spyOn(ignitor, 'start')
    const captured = captureOutput()
    await ignitor.console().handle(['greet', 'World'])
    captured.restore()

    expect(start).not.toHaveBeenCalled()
  })

  it('reports a missing required argument', async () => {
    // The command line reports rather than throws: the kernel owns the process,
    // and there is no caller to hand the error to. A missing argument is a call
    // error, so it is reported as ONE line — no stack, which would say nothing
    // about what the user typed.
    const captured = captureOutput()
    await new Ignitor(APP_ROOT).console().handle(['greet'])
    const output = captured.out()
    captured.restore()

    expect(output).toMatch(/Missing required argument "name"/)
    expect(output).not.toMatch(/at .*Kernel/)
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
  })
})
