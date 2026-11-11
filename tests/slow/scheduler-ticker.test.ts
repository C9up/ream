/**
 * The native ticker fires a task: Rust tick loop, threadsafe function, JS
 * callback, end to end.
 *
 * Cron is minute-grained, so this waits for the next minute boundary — up to
 * 60 s. It lives under `tests/slow`, which the default run leaves out
 * (`vitest.config.ts`) and CI runs as its own step with
 * `REAM_RUN_SLOW_TESTS=1`; it is never skipped, so the zero-skipped gate
 * covers it.
 */
import { expect, it } from 'vitest'
import { Scheduler } from '../../src/index.js'

it('fires a `*/1 * * * *` task at least once within 75 seconds', async () => {
  const scheduler = new Scheduler()
  let fires = 0
  scheduler.register('slow-tick', '*/1 * * * *', () => {
    fires += 1
  })
  scheduler.start()
  try {
    const deadline = Date.now() + 75_000
    while (fires === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  } finally {
    scheduler.stop()
    scheduler.unregister('slow-tick')
  }
  expect(fires).toBeGreaterThanOrEqual(1)
}, 80_000)
