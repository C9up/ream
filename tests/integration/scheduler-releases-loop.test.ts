/**
 * A registered task must not keep the process alive.
 *
 * `Scheduler.register()` creates a NAPI ThreadsafeFunction per task, and a
 * ThreadsafeFunction holds Node's event loop referenced for as long as it
 * lives. `stop()` cancels the tick loop, but the callbacks live on in the task
 * registry — so a process that had merely REGISTERED a task never exited. Every
 * console command that booted an app carrying a `@Schedule` ran to completion
 * and then hung, until a timeout or the operator killed it, which is what makes
 * such a command unusable from cron.
 *
 * Nothing in JS could show why: `process.getActiveResourcesInfo()` reports an
 * empty list, because the reference is held below it. So this is asserted the
 * only way it can be — by running a real process and seeing whether it ends.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const binary = path.join(packageRoot, `scheduler.${process.platform}-${process.arch}-gnu.node`)
const describeNative = existsSync(binary) ? describe : describe.skip

/** Run `script` in its own process and report whether it ended on its own. */
function runsToCompletion(script: string, timeoutMs = 15_000): { exited: boolean; stdout: string } {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: packageRoot,
    timeout: timeoutMs,
    encoding: 'utf8',
  })
  // `signal` is set when the timeout killed it — that IS the hang.
  return { exited: result.signal === null && result.status === 0, stdout: result.stdout ?? '' }
}

const load = `
  import { createRequire } from 'node:module'
  const require = createRequire(${JSON.stringify(`${packageRoot}/package.json`)})
  const { RustScheduler } = require(${JSON.stringify(binary)})
  const scheduler = RustScheduler.create ? RustScheduler.create() : new RustScheduler()
`

describeNative('ream > the scheduler is not a reason for a process to live', () => {
  it('ends a process that registered a task and stopped', () => {
    const { exited, stdout } = runsToCompletion(`${load}
      scheduler.register('nightly', '0 3 * * *', () => {})
      scheduler.start()
      scheduler.stop()
      console.log('done')
    `)
    expect(stdout).toContain('done')
    expect(exited).toBe(true)
  })

  it('ends a process that registered a task and never started', () => {
    // The console path: booting an app REGISTERS every @Schedule, and a command
    // that is not the server never calls start().
    const { exited } = runsToCompletion(`${load}
      scheduler.register('a', '0 3 * * *', () => {})
      scheduler.register('b', '*/5 * * * *', () => {})
    `)
    expect(exited).toBe(true)
  })

  it('still fires a task while something else holds the loop', () => {
    // The server case: the HTTP listener is what keeps the process running, and
    // the scheduler must tick inside it exactly as before.
    const { exited, stdout } = runsToCompletion(
      `${load}
      let fired = 0
      scheduler.register('tick', '* * * * *', () => { fired++ })
      scheduler.start()
      const keepAlive = setInterval(() => {}, 500)
      setTimeout(() => {
        clearInterval(keepAlive)
        scheduler.stop()
        console.log('fired=' + fired)
      }, 65_000)
    `,
      90_000,
    )
    expect(exited).toBe(true)
    expect(stdout.trim()).toBe('fired=1')
  }, 100_000)
})
