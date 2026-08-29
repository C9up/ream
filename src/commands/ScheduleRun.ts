/**
 * `schedule:run <name>` — run one registered task immediately.
 *
 * An admin override: it calls the task body directly, so it bypasses both the
 * cron schedule and the distributed lock. That is the point — you reach for it
 * when a task must run now, or to see it fail with your own eyes — and it is
 * also why the exit codes are distinct: `1` the task failed, `2` no such task,
 * `3` an invocation of it is already in flight.
 */

import { BaseCommand } from '../console/BaseCommand.js'
import { args } from '../console/decorators.js'
import type { CommandOptions } from '../console/types.js'
import { resolveScheduler } from './scheduler_resolver.js'

export default class ScheduleRun extends BaseCommand {
  static override commandName = 'schedule:run'
  static override description = 'Run a registered scheduled task once, now (bypasses the lock)'
  static override options: CommandOptions = { startApp: true }

  @args.string({ description: 'Task name, as `schedule:list` prints it' })
  declare name: string

  async run(): Promise<void> {
    // Rejected here rather than in the scheduler so the message arrives without
    // the operator first paying for a boot.
    if (this.name.trim() === '') {
      this.logger.error('Task name cannot be empty. Usage: schedule:run <name>')
      this.exitCode = 1
      return
    }

    const scheduler = await resolveScheduler(this)
    if (!scheduler) return

    const result = await scheduler.runTaskNow(this.name)
    const duration = Math.round(result.durationMs)

    if (result.outcome === 'unknown') {
      this.logger.error(
        `Unknown task: ${this.name}. Run "schedule:list" to see the registered tasks.`,
      )
      this.exitCode = 2
      return
    }

    if (result.outcome === 'already-running') {
      this.logger.error(
        `Task ${this.name} is already running in this process — skipped. Try again once it completes.`,
      )
      this.exitCode = 3
      return
    }

    if (result.outcome === 'completed') {
      this.logger.success(`${this.name} completed in ${duration} ms`)
      return
    }

    this.logger.error(
      `${this.name} failed after ${duration} ms: ${result.error?.message || 'unknown error'}`,
    )
    this.exitCode = 1
  }
}
