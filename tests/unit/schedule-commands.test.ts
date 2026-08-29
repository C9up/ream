/**
 * `schedule:list` / `schedule:run` — the framework's own commands, and the
 * loader that ships them.
 *
 * They used to be subcommands of the `ream` binary, driving an application
 * through JavaScript embedded in a Rust string literal. These tests cover what
 * that arrangement could not: the outcomes, their exit codes, and the message
 * an operator gets when the provider is not registered.
 */

import { describe, expect, it, vi } from 'vitest'
import { Application } from '../../src/Application.js'
import { getCommand, getMetaData } from '../../src/commands/index.js'
import ScheduleList from '../../src/commands/ScheduleList.js'
import ScheduleRun from '../../src/commands/ScheduleRun.js'
import { Kernel } from '../../src/console/Kernel.js'

interface FakeTask {
  name: string
  cronExpr: string
  nextRun: number | null
}

function schedulerWith(
  tasks: FakeTask[],
  runTaskNow: (...args: string[]) => unknown = async () => ({
    outcome: 'completed',
    durationMs: 4,
  }),
): Application {
  const application = new Application()
  application.container.singleton('scheduler', () => ({
    listTasks: () => tasks,
    getStats: () => ({
      lastRunMs: 1_700_000_000_000,
      nextRunMs: null,
      runCount: 3,
      successCount: 2,
      errorCount: 1,
      skippedCount: 0,
      avgDurationMs: 12.4,
    }),
    runTaskNow,
  }))
  return application
}

/** Run `command` through a kernel that hands it `application`. */
async function run(
  application: Application | undefined,
  argv: string[],
): Promise<{ output: string; exitCode: number | undefined }> {
  const kernel = new Kernel({ startApp: async () => application })
  // `raw` keeps every line in memory instead of printing it.
  kernel.ui.switchMode('raw')
  kernel.register(ScheduleList).register(ScheduleRun)
  const command = await kernel.exec(argv[0], argv.slice(1))
  return { output: kernel.ui.getLogs().join('\n'), exitCode: command.exitCode }
}

describe('ream > schedule commands', () => {
  it('ships both commands through the package loader', async () => {
    const metadata = await getMetaData()
    expect(metadata.map((entry) => entry.commandName)).toEqual(['schedule:list', 'schedule:run'])
    expect(metadata[0]?.namespace).toBe('schedule')
    // Both need the application: they read the scheduler out of its container.
    expect(metadata.every((entry) => entry.options.startApp === true)).toBe(true)

    expect(await getCommand(metadata[0])).toBe(ScheduleList)
    expect(await getCommand({ ...metadata[0], commandName: 'nope' })).toBeNull()
  })

  it('lists the registered tasks with their next run and stats', async () => {
    const application = schedulerWith([
      { name: 'reports:daily', cronExpr: '0 3 * * *', nextRun: 1_700_000_600_000 },
    ])
    const { output } = await run(application, ['schedule:list'])

    expect(output).toContain('NAME')
    expect(output).toContain('reports:daily')
    expect(output).toContain('0 3 * * *')
    expect(output).toContain(new Date(1_700_000_600_000).toISOString())
    // runCount / errorCount / rounded average.
    expect(output).toMatch(/\s3\s+1\s+12$/m)
  })

  it('says so when nothing is registered', async () => {
    const { output } = await run(schedulerWith([]), ['schedule:list'])
    expect(output).toContain('No scheduled tasks registered.')
  })

  it('reports a missing ScheduleProvider instead of a container error', async () => {
    const { output, exitCode } = await run(new Application(), ['schedule:list'])
    expect(output).toContain('ScheduleProvider')
    expect(exitCode).toBe(2)
  })

  it('runs one task now and reports how long it took', async () => {
    const runTaskNow = vi.fn(async () => ({ outcome: 'completed', durationMs: 41.6 }))
    const application = schedulerWith([], runTaskNow)
    const { output, exitCode } = await run(application, ['schedule:run', 'reports:daily'])

    expect(runTaskNow).toHaveBeenCalledWith('reports:daily')
    expect(output).toContain('reports:daily completed in 42 ms')
    expect(exitCode).toBe(0)
  })

  it('gives each failure its own exit code', async () => {
    const unknown = await run(
      schedulerWith([], async () => ({ outcome: 'unknown', durationMs: 0 })),
      ['schedule:run', 'typo'],
    )
    expect(unknown.exitCode).toBe(2)
    expect(unknown.output).toContain('schedule:list')

    const busy = await run(
      schedulerWith([], async () => ({ outcome: 'already-running', durationMs: 0 })),
      ['schedule:run', 'reports:daily'],
    )
    expect(busy.exitCode).toBe(3)

    const failed = await run(
      schedulerWith([], async () => ({
        outcome: 'failed',
        durationMs: 8,
        error: { name: 'Error', message: 'upstream refused' },
      })),
      ['schedule:run', 'reports:daily'],
    )
    expect(failed.exitCode).toBe(1)
    expect(failed.output).toContain('upstream refused')
  })

  it('refuses a blank task name without asking the scheduler to run it', async () => {
    const runTaskNow = vi.fn()
    const { exitCode, output } = await run(schedulerWith([], runTaskNow), ['schedule:run', '   '])

    expect(exitCode).toBe(1)
    expect(output).toContain('Task name cannot be empty')
    expect(runTaskNow).not.toHaveBeenCalled()
  })
})
