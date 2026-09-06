/**
 * `schedule:list` — every registered task, when it next fires, and how its past
 * runs went.
 *
 * The columns are the operator's questions in order: is my task registered at
 * all, on what schedule, when does it fire next, when did it last fire, and is
 * it failing. Stats come from the scheduler's own tracker, so a task that has
 * never run reads as `—` rather than a zero that looks like a result.
 */

import { BaseCommand } from '../console/BaseCommand.js'
import type { CommandOptions } from '../console/types.js'
import { resolveScheduler } from './scheduler_resolver.js'

/** Over-long names and cron expressions are truncated so the table stays a table. */
function truncate(value: string, width: number): string {
  return value.length > width ? `${value.slice(0, width - 1)}…` : value
}

function asDate(ms: number | null): string {
  return ms === null ? '—' : new Date(ms).toISOString()
}

export default class ScheduleList extends BaseCommand {
  static override commandName = 'schedule:list'
  static override description = 'List every registered scheduled task, its next run and its stats'
  static override options: CommandOptions = { startApp: true }

  async run(): Promise<void> {
    const scheduler = await resolveScheduler(this)
    if (!scheduler) return

    const tasks = scheduler.listTasks()
    if (tasks.length === 0) {
      this.logger.info('No scheduled tasks registered.')
      for (const line of whyNothingWasFound(this.app.rcFile.modules)) {
        this.logger.info(`  ${line}`)
      }
      return
    }

    this.logger.log(
      [
        'NAME'.padEnd(32),
        'CRON'.padEnd(18),
        'NEXT RUN'.padEnd(22),
        'LAST RUN'.padEnd(22),
        'RUNS'.padStart(6),
        'ERR'.padStart(5),
        'AVG(ms)'.padStart(9),
      ].join(' '),
    )

    for (const task of tasks) {
      const stats = scheduler.getStats(task.name)
      this.logger.log(
        [
          truncate(task.name, 32).padEnd(32),
          truncate(task.cronExpr, 18).padEnd(18),
          asDate(task.nextRun).padEnd(22),
          asDate(stats.lastRunMs).padEnd(22),
          String(stats.runCount).padStart(6),
          String(stats.errorCount).padStart(5),
          String(Math.round(stats.avgDurationMs)).padStart(9),
        ].join(' '),
      )
    }
  }
}

/**
 * Why an empty list is empty.
 *
 * Discovery walks the IoC service registry, and a class the process never
 * imported is not in it. `@Schedule` in `app/modules/**` therefore depends on
 * the module auto-loader having imported the file, and that has two conditions
 * a reader of the folder-structure guide would not expect. Saying "no tasks"
 * and stopping leaves them to find both by reading the Ignitor.
 */
function whyNothingWasFound(modules: { path?: string; autoload?: string[] } | undefined): string[] {
  if (modules?.path === undefined) {
    return [
      'A @Schedule is only found once something has imported the class that declares it.',
      'reamrc.ts has no `modules.path`, so nothing under app/modules/ is auto-loaded at all.',
      "Either add `modules: { path: './app/modules', autoload: ['routes', 'events'] }`,",
      'or import the file from a preload — which is explicit, and works anywhere.',
    ]
  }
  const autoload = modules.autoload ?? ['routes', 'events']
  return [
    'A @Schedule is only found once something has imported the class that declares it.',
    `modules.autoload is [${autoload.map((f) => `'${f}'`).join(', ')}], so app/modules/<name>/<file>.ts`,
    'is imported only under one of those names. Add the file name to that list,',
    'or import it from a preload — which is explicit, and works anywhere.',
  ]
}
