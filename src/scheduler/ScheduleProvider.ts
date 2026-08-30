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
import type { SchedulerConfig } from './config.js'
import { getScheduleMetadata } from './Schedule.js'
import { Scheduler, type SchedulerOptions } from './Scheduler.js'

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
  /** Task names already registered, so a second pass adds only what is new. */
  readonly #known = new Set<string>()
  #registered = false

  constructor(app: AppContext, options: ScheduleProviderOptions = {}) {
    super(app)
    this.scheduler =
      options.scheduler ?? new Scheduler(schedulerOptionsFrom(app.config.get('scheduler')))
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

  /**
   * Discovery runs at START, not at boot, and that is the whole point.
   *
   * `app/modules/**` is auto-loaded during the start phase — after every
   * provider has booted. A `@Service()` carrying `@Schedule` there, which is
   * where one naturally lives, was therefore registered into the service
   * registry AFTER this had already read it. The task was never registered,
   * and nothing said so: no error, no warning, the application started
   * normally and the task simply never fired.
   *
   * Reading the registry once the modules are in place is what fixes it. A
   * service declared anywhere earlier — a provider, a preload — is in the
   * registry by then too, so nothing is lost by waiting.
   */
  override async boot(): Promise<void> {
    // Anything already in the registry — declared by a provider, or imported
    // by one. The rest is caught at start().
    this.#discover()
  }

  override async start(): Promise<void> {
    this.#discover()
    if (activeProvider !== undefined && activeProvider !== this) {
      // A previous app's scheduler is still running — stop it before this one
      // starts, otherwise every @Schedule task fires twice per tick.
      activeProvider.scheduler.stop()
    }
    activeProvider = this
    this.scheduler.start()
  }

  /**
   * Walk the service registry and register every `@Schedule` it declares.
   *
   * Idempotent: a second call registers nothing twice, so an application that
   * restarts its Ignitor does not end up firing everything in duplicate.
   */
  #discover(): void {
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
          // Registered on an earlier pass: skip rather than fire it twice.
          if (this.#known.has(taskName)) continue
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
            this.#known.add(taskName)
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

  override async shutdown(): Promise<void> {
    if (activeProvider === this) activeProvider = undefined
    this.scheduler.stop()
  }
}

// Default export so reamrc's provider loader can `() => import('@c9up/ream/<feature>/provider')` (resolves to { default }), matching events/rpc. Named export above stays.
export default ScheduleProvider

/**
 * Turn `config/scheduler.ts` into the options the `Scheduler` takes.
 *
 * The lock is built here rather than in the config file because that file is
 * read before the application boots — a Redis connection named in it does not
 * exist yet, so the helpers hand back a factory and this calls it.
 */
function schedulerOptionsFrom(config: SchedulerConfig | undefined): SchedulerOptions {
  if (config === undefined) return {}
  const options: SchedulerOptions = {}
  if (config.lock !== undefined) {
    options.lockBackend = typeof config.lock === 'function' ? config.lock() : config.lock
  }
  if (config.defaultLockTtlMs !== undefined) {
    options.defaultLockTtlMs = config.defaultLockTtlMs
  }
  return options
}
