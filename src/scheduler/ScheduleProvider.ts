/**
 * `ScheduleProvider` — wires `@Schedule`-decorated methods into the
 * Rust-backed [`Scheduler`].
 *
 * Lifecycle:
 *   - `boot()` — walks the IoC service registry, reads each class's
 *     `@Schedule` metadata, and registers a callback per entry.
 *     Idempotent: calling `boot()` twice is a no-op on the second call.
 *     Partial failures are rolled back — if the Nth task's registration
 *     throws, tasks 1..N-1 registered in the same boot are unregistered
 *     before the error propagates, so the scheduler is never left in a
 *     half-registered state.
 *   - `start()` — launches the Rust tick loop.
 *   - `shutdown()` — cancels the Rust tick loop.
 *
 * The registered callback resolves the service **at invocation time**
 * (not registration time) via `container.make(target)`, so every run
 * receives freshly-DI'd dependencies for transient-scoped services.
 *
 * @implements Story 28.2
 */

import { getServiceRegistry } from '../decorators/Service.js'
import { ReamError } from '../errors/ReamError.js'
import type { AppContext } from '../Provider.js'
import { Provider } from '../Provider.js'
import { getScheduleMetadata } from './Schedule.js'
import { Scheduler } from './Scheduler.js'

export interface ScheduleProviderOptions {
  /**
   * Override the `Scheduler` instance — used by tests to inject a
   * mock. Production code relies on the default (`new Scheduler()`).
   */
  scheduler?: Scheduler
}

/** Prevents two ScheduleProvider instances from ticking simultaneously (two apps, same process). */
let activeProvider: ScheduleProvider | undefined

export class ScheduleProvider extends Provider {
  readonly scheduler: Scheduler
  #booted = false
  #registered = false

  constructor(app: AppContext, options: ScheduleProviderOptions = {}) {
    super(app)
    this.scheduler = options.scheduler ?? new Scheduler()
  }

  /**
   * Phase 1 — bind the scheduler into the IoC container under the
   * stable token `'scheduler'`. CLI entrypoints
   * (`ream schedule:list` / `ream schedule:run <name>`) retrieve the
   * scheduler via `container.resolve('scheduler')` once the app has
   * been booted through `Ignitor`. Consumers that import the
   * provider directly still read the `readonly scheduler` field.
   *
   * Idempotent: re-registering the same provider instance (hot
   * reload, repeated `app.start()` in tests) re-binds the same
   * scheduler without error. A DIFFERENT `ScheduleProvider` trying
   * to claim the `'scheduler'` token throws
   * `SCHEDULE_PROVIDER_ALREADY_REGISTERED` so dueling providers do
   * not silently overwrite each other.
   */
  override register(): void {
    const scheduler = this.scheduler
    const container = this.app.container
    if (container.has('scheduler')) {
      // Idempotent re-register: tracked with a flag rather than
      // `container.resolve('scheduler')` because resolution is now async.
      if (this.#registered) return
      throw new ReamError(
        'SCHEDULE_PROVIDER_ALREADY_REGISTERED',
        "Container token 'scheduler' is already bound to a different instance",
        {
          hint: 'Only one ScheduleProvider can own the scheduler binding. Remove the duplicate provider from your reamrc.ts.',
        },
      )
    }
    container.singleton('scheduler', () => scheduler)
    this.#registered = true
  }

  override async boot(): Promise<void> {
    if (this.#booted) return
    const registry = getServiceRegistry()
    const registered: string[] = []

    try {
      for (const [target] of registry) {
        const schedules = getScheduleMetadata(target)
        if (schedules.length === 0) continue

        if (!target.name) {
          throw new ReamError(
            'SCHEDULE_ANONYMOUS_CLASS',
            'Anonymous classes cannot declare @Schedule — task names would collide',
            {
              hint: 'Name the class explicitly (e.g. `export class Jobs { ... }`) so task names are unique and debuggable.',
            },
          )
        }

        for (const { cronExpr, methodName } of schedules) {
          // Reject symbol method keys — `String(Symbol('x'))` yields
          // `Symbol(x)` which collides across distinct symbol instances
          // sharing the same description. String keys are the
          // documented contract.
          if (typeof methodName === 'symbol') {
            throw new ReamError(
              'SCHEDULE_SYMBOL_METHOD',
              `@Schedule on symbol-keyed method is not supported on class '${target.name}'`,
              {
                hint: 'Use a regular named method so the task can be addressed uniquely.',
              },
            )
          }

          const taskName = `${target.name}.${methodName}`
          try {
            this.scheduler.register(taskName, cronExpr, async () => {
              // Resolve from the container on every fire so transient
              // services get a fresh instance each run.
              const instance = await this.app.container.make<Record<string, unknown>>(target)
              const method = instance[methodName]
              if (typeof method !== 'function') {
                throw new ReamError(
                  'SCHEDULE_METHOD_NOT_FOUND',
                  `Scheduled method ${taskName} is not callable on resolved instance`,
                )
              }
              await (method as (...args: unknown[]) => unknown).call(instance)
            })
            registered.push(taskName)
          } catch (cause) {
            const inner = cause as ReamError & { message?: string; hint?: string }
            throw new ReamError(
              'SCHEDULE_INVALID_CRON',
              `Failed to register scheduled task '${taskName}': ${inner.message ?? String(cause)}`,
              {
                context: { task: taskName, cronExpr },
                hint: inner.hint,
              },
            )
          }
        }
      }
      this.#booted = true
    } catch (err) {
      // Roll back any partial registrations so a retry does not hit
      // DUPLICATE_TASK and the scheduler is never half-initialized.
      for (const name of registered) {
        try {
          this.scheduler.unregister(name)
        } catch {
          // Best-effort rollback; swallow secondary failures so the
          // original error reaches the caller unchanged.
        }
      }
      throw err
    }
  }

  override async start(): Promise<void> {
    if (activeProvider !== undefined && activeProvider !== this) {
      // A previous app's scheduler is still running — stop it before this one starts,
      // otherwise every @Schedule task fires twice per tick.
      activeProvider.scheduler.stop()
    }
    activeProvider = this
    this.scheduler.start()
  }

  override async shutdown(): Promise<void> {
    if (activeProvider === this) activeProvider = undefined
    this.scheduler.stop()
  }
}

// Default export so reamrc's provider loader can `() => import('@c9up/ream/<feature>/provider')` (resolves to { default }), matching events/rpc. Named export above stays.
export default ScheduleProvider
