import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { Application } from '../../src/Application.js'
import { BaseCommand } from '../../src/console/BaseCommand.js'
import { Kernel } from '../../src/console/Kernel.js'
import { Inject } from '../../src/decorators/Service.js'

class Mailer {
  readonly sent: string[] = []
  send(to: string): void {
    this.sent.push(to)
  }
}

class Reporter {
  readonly seen: string[] = []
}

function bootedApp(): Application {
  const app = new Application()
  app.container.singleton('mailer', () => new Mailer())
  app.container.singleton('reporter', () => new Reporter())
  return app
}

describe('command dependency injection (Console parity)', () => {
  it('injects constructor dependencies through the container', async () => {
    let received: unknown

    class Notify extends BaseCommand {
      static override commandName = 'notify'
      static override description = 'Injects a service in its constructor'
      static override options = { startApp: true }

      constructor(@Inject('mailer') private mailer: Mailer) {
        super()
      }

      run(): void {
        this.mailer.send('ada@example.ch')
        received = this.mailer
      }
    }

    const app = bootedApp()
    const kernel = new Kernel({ startApp: async () => app }).register(Notify)
    await kernel.exec('notify')

    expect(received).toBeInstanceOf(Mailer)
    expect((received as Mailer).sent).toEqual(['ada@example.ch'])
  })

  it('injects into run() and the other lifecycle hooks', async () => {
    const order: string[] = []

    class Report extends BaseCommand {
      static override commandName = 'report'
      static override description = 'Injects into its lifecycle methods'
      static override options = { startApp: true }

      override prepare(@Inject('reporter') reporter: Reporter): void {
        order.push(`prepare:${reporter.constructor.name}`)
      }

      run(@Inject('mailer') mailer: Mailer): string {
        order.push(`run:${mailer.constructor.name}`)
        return 'done'
      }

      override completed(@Inject('reporter') reporter: Reporter): void {
        order.push(`completed:${reporter.constructor.name}`)
      }
    }

    const app = bootedApp()
    const command = await new Kernel({ startApp: async () => app }).register(Report).exec('report')

    expect(order).toEqual(['prepare:Reporter', 'run:Mailer', 'completed:Reporter'])
    expect(command.result).toBe('done')
    expect(command.exitCode).toBe(0)
  })

  it('gives each execution its own command instance', async () => {
    const instances: unknown[] = []

    class Counting extends BaseCommand {
      static override commandName = 'counting'
      static override description = 'Records its identity'
      static override options = { startApp: true }
      run(): void {
        instances.push(this)
      }
    }

    const app = bootedApp()
    const kernel = new Kernel({ startApp: async () => app }).register(Counting)
    await kernel.exec('counting')
    await kernel.exec('counting')

    // Two runs must not share state through a cached instance.
    expect(instances).toHaveLength(2)
    expect(instances[0]).not.toBe(instances[1])
  })

  it('still runs a command that never asked for the application', async () => {
    class Standalone extends BaseCommand {
      static override commandName = 'standalone'
      static override description = 'No startApp, no container'
      run(): string {
        return 'ok'
      }
    }

    // No container involved at all — the plain `new Command()` path.
    const command = await new Kernel().register(Standalone).exec('standalone')
    expect(command.result).toBe('ok')
  })
})
