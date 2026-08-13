/**
 * Diagnostics channels for the console (Ace `tracingChannels`).
 *
 * `diagnostics_channel` is Node's built-in tracing hook: an APM agent, or a
 * test, subscribes without the framework knowing about it and without paying
 * anything when nobody listens.
 */

import diagnosticsChannel from 'node:diagnostics_channel'
import type { CommandClass, CommandInstance } from './types.js'

export interface CommandExecTracingData {
  command: CommandClass
  commandInstance: CommandInstance
  argv: readonly string[]
}

/** Traces every command run by the kernel — start, end, error and result. */
export const commandExec = diagnosticsChannel.tracingChannel<
  'ream.command.exec',
  CommandExecTracingData
>('ream.command.exec')
