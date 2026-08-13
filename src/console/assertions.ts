/**
 * Test assertions attached to every command the kernel runs.
 *
 * They live here rather than only on `BaseCommand` so that what `exec()`
 * returns always carries them — including a command declared structurally by a
 * framework-agnostic package. A type that promises them while the runtime
 * sometimes lacks them is worse than no type at all.
 */

import type { CapturedLog, Ui } from './cliui.js'
import type { CommandAssertions, CommandInstance, CommandSnapshot } from './types.js'

/** What the assertions need from the command they belong to. */
interface Subject extends CommandInstance {
  exitCode?: number
  error?: unknown
}

export function createAssertions(command: Subject, ui: Ui): CommandAssertions {
  const logs = (): CapturedLog[] => ui.getCapturedLogs()

  return {
    assertSucceeded(): void {
      if (command.exitCode === 0) return
      throw new Error(
        `Expected the command to succeed, but it exited with ${String(command.exitCode)}.` +
          (command.error === undefined ? '' : `\n  Cause: ${String(command.error)}`),
      )
    },

    assertFailed(): void {
      if (command.exitCode !== 0) return
      throw new Error('Expected the command to fail, but it exited with 0.')
    },

    assertExitCode(expected: number): void {
      if (command.exitCode === expected) return
      throw new Error(`Expected exit code ${expected}, got ${String(command.exitCode)}.`)
    },

    assertNotExitCode(unexpected: number): void {
      if (command.exitCode !== unexpected) return
      throw new Error(`Expected the exit code NOT to be ${unexpected}.`)
    },

    assertLog(message: string, stream?: 'stdout' | 'stderr'): void {
      const captured = logs()
      const found = captured.some(
        (entry) => entry.message === message && (stream === undefined || entry.stream === stream),
      )
      if (found) return
      throw new Error(
        `Expected a log ${stream === undefined ? '' : `on ${stream} `}equal to:\n  ${message}\n` +
          `Got:\n${formatLogs(captured)}`,
      )
    },

    assertLogMatches(pattern: RegExp, stream?: 'stdout' | 'stderr'): void {
      const captured = logs()
      const found = captured.some(
        (entry) => pattern.test(entry.message) && (stream === undefined || entry.stream === stream),
      )
      if (found) return
      throw new Error(`Expected a log matching ${String(pattern)}.\nGot:\n${formatLogs(captured)}`)
    },

    /**
     * Ace's semantics: every expected row must be PRESENT among the rendered
     * ones — a subset check, not an equality. The header counts as a row, so
     * `[['Name', 'Email'], ['Ada', '…']]` and `[['Ada', '…']]` are both valid
     * assertions, exactly as in Ace, where a table row is logged as its cells
     * joined by `|` and the head goes through the same path.
     */
    assertTableRows(expected: readonly (readonly string[])[]): void {
      const head = ui.getTableHead()
      const actual = head.length === 0 ? ui.getTableRows() : [head, ...ui.getTableRows()]
      const missing = expected.filter(
        (wanted) =>
          !actual.some(
            (row) =>
              row.length === wanted.length && row.every((cell, column) => cell === wanted[column]),
          ),
      )
      if (missing.length === 0) return
      throw new Error(
        `Expected the table to include the rows:\n${JSON.stringify(missing, null, 2)}\n` +
          `Got:\n${JSON.stringify(actual, null, 2)}`,
      )
    },
  }
}

/** The execution snapshot (Ace `toJSON`), for a command built structurally. */
export function createSnapshot(
  command: Subject,
  commandName: string,
  options: CommandSnapshot['options'],
): () => CommandSnapshot {
  return () => ({
    commandName,
    options,
    // Ace exposes the positional values as a list; flags stay keyed.
    args: [...(Reflect.get(command, 'parsed')?.args ?? [])],
    flags: Reflect.get(command, 'parsed')?.flags ?? {},
    error: command.error,
    result: Reflect.get(command, 'result'),
    exitCode: command.exitCode,
  })
}

function formatLogs(captured: readonly CapturedLog[]): string {
  if (captured.length === 0) return '  (nothing was logged — is the UI in raw mode?)'
  return captured.map((entry) => `  [${entry.stream}] ${entry.message}`).join('\n')
}
