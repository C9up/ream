/**
 * Resolve the scheduler for the `schedule:*` commands.
 *
 * Shared because the failure is the same one on both, and it is a
 * configuration mistake rather than a crash: the provider is simply not in the
 * list, and the message has to say so — a container error mentioning an
 * unbound `scheduler` binding tells an operator nothing.
 */

import type { BaseCommand } from '../console/BaseCommand.js'
import type { Scheduler } from '../scheduler/Scheduler.js'

export async function resolveScheduler(command: BaseCommand): Promise<Scheduler | undefined> {
  try {
    return await command.app.container.resolve<Scheduler>('scheduler')
  } catch {
    command.logger.error(
      'No ScheduleProvider is registered. Add ScheduleProvider to the providers list in reamrc.ts.',
    )
    command.exitCode = 2
    return undefined
  }
}
