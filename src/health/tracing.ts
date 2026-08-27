import diagnostics_channel from 'node:diagnostics_channel'
import type { HealthCheckTracingData } from './types.js'

/**
 * A diagnostics channel carrying every check run, so an APM can time checks
 * without the app wiring anything.
 *
 * NAMED DEVIATION — the channel is `ream.health.check`, not upstream's
 * `adonisjs.health.check`. A channel name is product identity, and a subscriber
 * listening for both frameworks in one process must be able to tell them apart.
 */
export const healthCheck = diagnostics_channel.tracingChannel<
  'ream.health.check',
  HealthCheckTracingData
>('ream.health.check')
