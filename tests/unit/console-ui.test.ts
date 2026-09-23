import { describe, expect, it } from 'vitest'
import { BaseCommand } from '../../src/console/BaseCommand.js'
import { stripAnsi, Ui } from '../../src/console/cliui.js'
import { args, flags } from '../../src/console/decorators.js'
import { Kernel } from '../../src/console/Kernel.js'

function rawUi(): Ui {
  const ui = new Ui()
  ui.switchMode('raw')
  return ui
}

describe('Ui — raw mode', () => {
  it('keeps every line in memory instead of printing it', () => {
    const ui = rawUi()
    ui.logger.info('Hello world')
    ui.logger.success('Done')

    // Colours are spelled out in raw mode, so an expected log stays readable.
    expect(ui.getLogs()).toEqual(['[ blue(info) ] Hello world', '[ green(success) ] Done'])
  })

  it('starts from a clean slate each time raw mode is entered', () => {
    const ui = rawUi()
    ui.logger.info('first')
    ui.switchMode('raw')
    expect(ui.getLogs()).toEqual([])
  })

  it('honours the logger prefix and suffix', () => {
    const ui = rawUi()
    ui.logger.prefix('app').suffix('v1')
    ui.logger.info('booted')
    // The brackets and parentheses belong to the format, not to the value the
    // caller passes — so a prefix reads the same wherever it comes from.
    expect(ui.getLogs()).toEqual(['dim([app]) [ blue(info) ] booted dim(yellow((v1)))'])
  })
})

describe('Ui — logger actions', () => {
  it('reports succeeded, skipped and failed', () => {
    const ui = rawUi()
    ui.logger.action('creating config/auth.ts').succeeded()
    ui.logger.action('creating config/app.ts').skipped('already exists')
    ui.logger.action('creating config/db.ts').failed(new Error('permission denied'))

    const logs = ui.getLogs()
    // The labels are padded to the width of the longest one, so a column of
    // actions lines up whatever the outcome.
    expect(logs[0]).toBe('green(DONE:   ) creating config/auth.ts')
    expect(logs[1]).toBe('cyan(SKIPPED:) creating config/app.ts dim((already exists))')
    // A failure carries its stack, indented under the line.
    expect(logs[2]?.startsWith('red(FAILED: ) creating config/db.ts\n')).toBe(true)
    expect(logs[2]).toContain('red(Error: permission denied)')
  })

  it('appends a duration when asked', () => {
    const ui = rawUi()
    ui.logger.action('slow thing').displayDuration().succeeded()
    expect(ui.getLogs()[0]).toMatch(/green\(DONE: +\) slow thing dim\(\(\d+m?s\)\)/)
  })
})

describe('Ui — table', () => {
  it('joins the cells with a pipe in raw mode', () => {
    // Raw mode is what a test asserts on: the cells, with no border, no
    // colour and no alignment to break when a column grows.
    const ui = rawUi()
    ui.table().head(['Migration', 'Status']).row(['1590591892626_tenants.ts', 'DONE']).render()

    expect(ui.getLogs()).toEqual(['Migration|Status', '1590591892626_tenants.ts|DONE'])
  })

  it('draws a bordered table, aligned on the VISIBLE width', () => {
    // Outside raw mode it is a real table. The invariant is that every line
    // is the same width — a cell coloured green carries escape codes that
    // occupy no columns, and counting them would bend the border.
    const ui = new Ui()
    const lines: string[] = []
    ui.useRenderer({
      log: (line: string) => lines.push(line),
      logError: (line: string) => lines.push(line),
      logUpdate: () => {},
      logUpdatePersist: () => {},
      getLogs: () => [],
      flushLogs: () => {},
    })
    ui.table()
      .head(['Migration', 'Status'])
      .row(['1590591892626_tenants.ts', ui.colors.green('DONE')])
      .row(['short.ts', 'PENDING'])
      .render()

    const widths = new Set(lines.map((line) => stripAnsi(line).length))
    expect(widths.size).toBe(1)
    expect(stripAnsi(lines[0] ?? '').startsWith('┌')).toBe(true)
    expect(stripAnsi(lines.at(-1) ?? '').startsWith('└')).toBe(true)
  })

  it('renders nothing when it has no rows', () => {
    const ui = rawUi()
    ui.table().render()
    expect(ui.getLogs()).toEqual([])
  })
})

describe('Ui — sticker and instructions', () => {
  it('boxes the lines', () => {
    const ui = rawUi()
    ui.sticker().add('Started HTTP server').add('http://localhost:3333').render()

    const logs = ui.getLogs()
    // Border, a blank row, the two lines, a blank row, border — the padding
    // is what keeps the text off the border.
    expect(logs).toHaveLength(6)
    expect(logs[2]).toContain('Started HTTP server')
    expect(logs[0]?.startsWith('dim(╭')).toBe(true)
  })

  it('marks each instruction with a pointer', () => {
    const ui = rawUi()
    ui.instructions().add('cd my-app').add('ream dev').render()

    expect(ui.getLogs()[2]).toContain('dim(❯) cd my-app')
    expect(ui.getLogs()[3]).toContain('dim(❯) ream dev')
  })
})

describe('Ui — tasks', () => {
  it('runs them in order and reports each outcome', async () => {
    const ui = rawUi()
    const outcomes = await ui
      .tasks()
      .add('clone repo', async (task) => {
        task.update('Downloaded 50%')
        return 'Completed'
      })
      .add('install dependencies', async () => 'Installed')
      .run()

    expect(outcomes.map((o) => o.state)).toEqual(['succeeded', 'succeeded'])
    // Minimal mode (the default) does not print a line per progress message.
    expect(ui.getLogs()).not.toContain('  dim(clone repo: Downloaded 50%)')
    // Each line ends with how long the task took.
    expect(ui.getLogs()[0]).toMatch(/^green\(✔\) clone repo dim\(Completed\) dim\(\(\d+m?s\)\)$/)
  })

  it('stops at the first failure — later steps usually depend on it', async () => {
    const ui = rawUi()
    const ran: string[] = []

    const outcomes = await ui
      .tasks()
      .add('first', async () => {
        ran.push('first')
        return 'ok'
      })
      .add('second', async (task) => {
        ran.push('second')
        return task.error('Unable to update package file')
      })
      .add('third', async () => {
        ran.push('third')
        return 'ok'
      })
      .run()

    expect(ran).toEqual(['first', 'second'])
    expect(outcomes.map((o) => o.state)).toEqual(['succeeded', 'failed'])
    expect(outcomes[1]?.message).toBe('Unable to update package file')
  })

  it('treats a thrown error as a failed task', async () => {
    const ui = rawUi()
    const outcomes = await ui
      .tasks()
      .add('boom', async () => {
        throw new Error('exploded')
      })
      .run()

    expect(outcomes[0]?.state).toBe('failed')
    expect(outcomes[0]?.message).toBe('exploded')
  })
})

describe('Ui — colors', () => {
  it('chains styles, as Console does', () => {
    const ui = rawUi()
    expect(ui.colors.red('[ERROR]')).toBe('red([ERROR])')
    expect(ui.colors.bgGreen().white(' CREATED ')).toBe('bgGreen(white( CREATED ))')
  })
})

describe('Ui — inside a command', () => {
  it('gives the command a ui and colors it can assert on', async () => {
    class Report extends BaseCommand {
      static override commandName = 'report'
      static override description = 'Renders a table'

      run(): void {
        this.ui
          .table()
          .head(['Name'])
          .row([this.colors.green('Ada')])
          .render()
        this.logger.info('done')
      }
    }

    const kernel = new Kernel().register(Report)
    // The kernel owns the UI, so a test switches it to raw and reads the logs.
    kernel.ui.switchMode('raw')
    const command = await kernel.exec('report')

    expect(command.exitCode).toBe(0)
    // Raw mode: the table is its cells, one row per line, and the logger
    // line keeps its spelled-out colour.
    expect(kernel.ui.getLogs()).toEqual(['Name', 'green(Ada)', '[ blue(info) ] done'])
  })
})

describe('Ui — column alignment with real ANSI colours', () => {
  it('measures visible width, not escape codes', () => {
    const previous = process.env.FORCE_COLOR
    process.env.FORCE_COLOR = '1'
    try {
      const ui = new Ui() // normal mode: colours are real escape sequences
      const lines: string[] = []
      const write = (line: string): void => {
        lines.push(line)
      }
      Object.defineProperty(ui, 'write', { value: write })

      ui.table()
        .head(['Status', 'File'])
        .row([ui.colors.green('DONE'), 'a.ts'])
        .render()

      // The coloured cell carries escape codes; padded on visible width, its
      // column stays 6 wide ("Status"), so "a.ts" starts at the same offset as
      // "File" on the header line.
      const stripped = lines.map(stripAnsi)
      expect(stripped[0]?.indexOf('File')).toBe(stripped[2]?.indexOf('a.ts'))
    } finally {
      if (previous === undefined) delete process.env.FORCE_COLOR
      else process.env.FORCE_COLOR = previous
    }
  })
})

describe('Ui — Console option contracts', () => {
  it('takes prefix and suffix per message', () => {
    const ui = rawUi()
    ui.logger.info('installing packages', { suffix: 'npm i --production' })
    ui.logger.info('starting', { prefix: 4242 })

    expect(ui.getLogs()).toEqual([
      '[ blue(info) ] installing packages dim(yellow((npm i --production)))',
      'dim([4242]) [ blue(info) ] starting',
    ])
  })

  it('prints an await message once when it cannot animate', () => {
    const ui = rawUi()
    const animation = ui.logger.await('installing packages', { suffix: 'npm i' })
    animation.start()
    animation.update('unpacking packages')
    animation.stop()

    // No TTY: one line per state instead of a frame-per-tick flood.
    expect(ui.getLogs()).toEqual([
      '[ cyan(wait) ] installing packages dim(yellow((npm i)))',
      'unpacking packages',
    ])
  })

  it('right-aligns a cell declared with hAlign', () => {
    // Alignment is a property of the DRAWN table, so this one leaves raw
    // mode: there is nothing to align in `a|b`.
    const ui = new Ui()
    const lines: string[] = []
    ui.useRenderer({
      log: (line: string) => lines.push(line),
      logError: (line: string) => lines.push(line),
      logUpdate: () => {},
      logUpdatePersist: () => {},
      getLogs: () => [],
      flushLogs: () => {},
    })
    ui.table()
      .head(['Migration', { content: 'Status', hAlign: 'right' }])
      .row(['a_very_long_migration.ts', { content: 'DONE', hAlign: 'right' }])
      .row(['b.ts', { content: 'PENDING', hAlign: 'right' }])
      .render()

    // Both right-aligned cells end at the same column, padding then border.
    const done = stripAnsi(lines[3] ?? '')
    const pending = stripAnsi(lines[4] ?? '')
    expect(done.indexOf('DONE') + 'DONE'.length).toBe(pending.indexOf('PENDING') + 'PENDING'.length)
  })

  it('prints every progress message in verbose mode', async () => {
    const ui = rawUi()
    await ui
      .tasks({ verbose: true })
      .add('clone repo', async (task) => {
        task.update('Downloaded 50%')
        task.update('Downloaded 100%')
        return 'Completed'
      })
      .run()

    expect(ui.getLogs()).toContain('  dim(clone repo: Downloaded 50%)')
    expect(ui.getLogs()).toContain('  dim(clone repo: Downloaded 100%)')
  })

  it('surfaces the last progress message when the task returns nothing', async () => {
    const ui = rawUi()
    await ui
      .tasks()
      .add('sync', async (task) => {
        task.update('42 files')
      })
      .run()

    expect(ui.getLogs()[0]).toMatch(/^green\(✔\) sync dim\(42 files\) dim\(\(\d+m?s\)\)$/)
  })
})

describe('Command — test assertions', () => {
  class Report extends BaseCommand {
    static override commandName = 'report'
    static override description = 'Logs and renders a table'

    run(): void {
      this.logger.info('Hello world from "Report"')
      this.logger.warning('careful')
      this.ui
        .table()
        .head(['Name', 'Email'])
        .row(['Harminder Virk', 'virk@adonisjs.com'])
        .row(['Romain Lanz', 'romain@adonisjs.com'])
        .render()
    }
  }

  it('asserts logs, streams, tables and exit code', async () => {
    const kernel = new Kernel().register(Report)
    kernel.ui.switchMode('raw')
    const command = await kernel.exec('report')

    command.assertSucceeded()
    command.assertExitCode(0)
    command.assertLog('[ blue(info) ] Hello world from "Report"')
    command.assertLogMatches(/Hello world/)
    // A warning belongs on stderr — asserting the stream is the point.
    command.assertLog('[ yellow(warn) ] careful', 'stderr')
    command.assertTableRows([
      ['Harminder Virk', 'virk@adonisjs.com'],
      ['Romain Lanz', 'romain@adonisjs.com'],
    ])
  })

  it('accepts the header among the expected rows, as Console documents it', async () => {
    const kernel = new Kernel().register(Report)
    kernel.ui.switchMode('raw')
    const command = await kernel.exec('report')

    // Console's own example restates the head; its check is "every expected row is
    // present", so a subset — head or no head — is equally valid.
    command.assertTableRows([
      ['Name', 'Email'],
      ['Romain Lanz', 'romain@adonisjs.com'],
    ])
    command.assertTableRows([['Name', 'Email']])
    expect(() => command.assertTableRows([['Name', 'Nope']])).toThrow(/Nope/)
  })

  it('asserts the same way whether the command came from the kernel or not', async () => {
    const kernel = new Kernel().register(Report)
    kernel.ui.switchMode('raw')
    await kernel.exec('report')

    // The kernel ATTACHES its assertions; BaseCommand also declares them. A
    // command held as a plain instance must not answer differently — it did,
    // until both went through one implementation.
    const direct = new Report()
    Object.assign(direct, { ui: kernel.ui, exitCode: 0 })

    direct.assertTableRows([
      ['Name', 'Email'],
      ['Romain Lanz', 'romain@adonisjs.com'],
    ])
    direct.assertSucceeded()
    expect(() => direct.assertTableRows([['Nope', 'Nope']])).toThrow(/Nope/)
  })

  it('reports what was actually logged when an assertion fails', async () => {
    const kernel = new Kernel().register(Report)
    kernel.ui.switchMode('raw')
    const command = await kernel.exec('report')

    // The failure message has to show the real output, or a failing test says
    // nothing about why.
    expect(() => command.assertLog('nope')).toThrow(/Hello world from "Report"/)
    expect(() => command.assertLog('[ yellow(warn) ] careful', 'stdout')).toThrow(/on stdout/)
    expect(() => command.assertFailed()).toThrow(/Expected the command to fail/)
  })
})

describe('BaseCommand — metadata and runtime declaration', () => {
  it('serializes its contract', () => {
    class Provision extends BaseCommand {
      static override commandName = 'provision'
      static override description = 'Creates the owner'
      static override aliases = ['prov']
      static override options = { startApp: true }
      run(): void {}
    }
    Provision.defineFlag('email', { type: 'string', required: true })
    Provision.defineArgument('name')

    const serialized = Provision.serialize()
    expect(serialized.commandName).toBe('provision')
    expect(serialized.aliases).toEqual(['prov'])
    expect(serialized.options.startApp).toBe(true)
    expect(serialized.flags[0]).toMatchObject({ flagName: 'email', required: true })
    expect(serialized.args[0]).toMatchObject({ argumentName: 'name', required: true })
  })

  it('declares inputs at runtime and parses them', async () => {
    let seen: { name: string; retries: number } | undefined

    class Sync extends BaseCommand {
      static override commandName = 'sync'
      static override description = 'Declared without decorators'
      run(): void {
        // Read through the parsed bag on purpose: positionals by position,
        // flags by their command-line name (Console's shape).
        seen = {
          name: String(this.parsed.args[0]),
          retries: Number(this.parsed.flags.retries),
        }
      }
    }
    // A package that must not import the framework's decorators can still
    // declare typed inputs.
    Sync.defineArgument('name')
    Sync.defineFlag('retries', { type: 'number' })

    const command = await new Kernel().register(Sync).exec('sync', ['ada', '--retries', '3'])
    command.assertSucceeded()
    expect(seen).toEqual({ name: 'ada', retries: 3 })
  })

  it('does not leak runtime declarations onto sibling commands', () => {
    class Parent extends BaseCommand {
      static override commandName = 'parent'
      static override description = 'Parent'
      run(): void {}
    }
    class Child extends Parent {
      static override commandName = 'child'
      static override description = 'Child'
    }
    Child.defineFlag('only-child', { type: 'boolean' })

    expect(Parent.flags.map((flag) => flag.flagName)).toEqual([])
    expect(Child.flags.map((flag) => flag.flagName)).toEqual(['only-child'])
  })

  it('reports whether it was the command invoked on the command line', async () => {
    const seen: boolean[] = []
    class Where extends BaseCommand {
      static override commandName = 'where'
      static override description = 'Reports isMain'
      run(): void {
        seen.push(this.isMain)
      }
    }

    // Two kernels on purpose: once the command line's command has finished, its
    // kernel is done — Console refuses to run anything more through it.
    const cli = new Kernel().register(Where)
    cli.ui.switchMode('raw')
    await cli.handle(['where']) // the command line

    const programmatic = new Kernel().register(Where)
    programmatic.ui.switchMode('raw')
    await programmatic.exec('where') // another caller

    expect(seen).toEqual([true, false])
  })

  it('assertNotExitCode rejects the code it was given', async () => {
    class Fails extends BaseCommand {
      static override commandName = 'fails'
      static override description = 'Exits 2'
      run(): void {
        this.exitCode = 2
      }
    }
    const command = await new Kernel().register(Fails).exec('fails')
    command.assertNotExitCode(0)
    expect(() => command.assertNotExitCode(2)).toThrow(/NOT to be 2/)
  })
})

describe('Ui — fluid column', () => {
  it('grows the first column by default', () => {
    const ui = new Ui()
    const lines: string[] = []
    ui.useRenderer({
      log: (line: string) => lines.push(line),
      logError: (line: string) => lines.push(line),
      logUpdate: () => {},
      logUpdatePersist: () => {},
      getLogs: () => [],
      flushLogs: () => {},
    })
    Object.defineProperty(process.stdout, 'columns', { value: 60, configurable: true })

    ui.table().fullWidth().head(['a', 'b']).row(['x', 'y']).render()

    // The table now fills the terminal, and the slack went to column 0.
    expect(stripAnsi(lines[0] ?? '').length).toBe(60)
    expect(stripAnsi(lines[0] ?? '').indexOf('┬')).toBeGreaterThan(40)
  })

  it('grows the column chosen by fluidColumnIndex', () => {
    const ui = new Ui()
    const lines: string[] = []
    ui.useRenderer({
      log: (line: string) => lines.push(line),
      logError: (line: string) => lines.push(line),
      logUpdate: () => {},
      logUpdatePersist: () => {},
      getLogs: () => [],
      flushLogs: () => {},
    })
    Object.defineProperty(process.stdout, 'columns', { value: 60, configurable: true })

    ui.table().fullWidth().fluidColumnIndex(1).head(['a', 'b']).row(['x', 'y']).render()

    // The top border shows the allocated widths: the divider sits early, so
    // it is the SECOND column that took the slack.
    const top = stripAnsi(lines[0] ?? '')
    expect(top.length).toBe(60)
    expect(top.indexOf('┬')).toBeLessThan(10)
  })
})

describe('BaseCommand — toJSON is an execution snapshot', () => {
  class Provision extends BaseCommand {
    static override commandName = 'provision'
    static override description = 'Creates the owner'
    static override help = ['Example: {{ binaryName }} provision --email a@b.ch']

    run(): string {
      this.exitCode = 0
      return 'created'
    }
  }
  Provision.defineFlag('email', { type: 'string' })

  it('carries the run state, not the static contract', async () => {
    const command = await new Kernel().register(Provision).exec('provision', ['--email', 'a@b.ch'])
    const snapshot = command.toJSON()

    // What a test or an integration reads after running a command.
    expect(snapshot.commandName).toBe('provision')
    expect(snapshot.flags).toEqual({ email: 'a@b.ch' })
    expect(snapshot.result).toBe('created')
    expect(snapshot.exitCode).toBe(0)
    expect(snapshot.error).toBeUndefined()
  })

  it('reports the failure of a run', async () => {
    class Fails extends BaseCommand {
      static override commandName = 'fails'
      static override description = 'Throws'
      run(): void {
        throw new Error('nope')
      }
    }

    // exec() rejects on a failure (Console). To inspect the command instead, build
    // it with create() and drive it — which is the Console path too.
    const kernel = new Kernel().register(Fails)
    await expect(kernel.exec('fails')).rejects.toThrow('nope')

    const command = await kernel.create(Fails)
    await expect(command.exec()).rejects.toThrow('nope')
    const snapshot = command.toJSON()

    expect(snapshot.exitCode).toBe(1)
    expect(String(snapshot.error)).toContain('nope')
  })

  it('serialize() stays the static contract, help included and JSON-safe', () => {
    const meta = Provision.serialize()

    expect(meta.help).toEqual(['Example: {{ binaryName }} provision --email a@b.ch'])
    expect(meta.flags[0]?.flagName).toBe('email')
    // No function survives a round-trip through JSON, so none should be here.
    expect('parse' in (meta.flags[0] ?? {})).toBe(false)
    expect(JSON.parse(JSON.stringify(meta))).toEqual(meta)
  })
})

describe('Ui — fluid column guards', () => {
  it('rejects an index that is not a column position', () => {
    const ui = new Ui()
    expect(() => ui.table().fluidColumnIndex(-1)).toThrow(/not a column position/)
    expect(() => ui.table().fluidColumnIndex(1.5)).toThrow(/not a column position/)
  })

  it('rejects an index beyond the table width', () => {
    const ui = new Ui()
    ui.switchMode('raw')
    expect(() =>
      ui.table().fullWidth().fluidColumnIndex(4).head(['a', 'b']).row(['x', 'y']).render(),
    ).toThrow(/out of range — the table has 2 column\(s\)/)
  })
})

describe('Command — public contract of exec()', () => {
  it('exposes the assertions on the returned type, not only at runtime', async () => {
    // Structural command: it never extends BaseCommand, yet exec() promises
    // these — the kernel attaches them.
    const Structural = class {
      static commandName = 'structural'
      static description = 'Declared without BaseCommand'
      run(): string {
        return 'ok'
      }
    }

    const kernel = new Kernel().register(Structural)
    kernel.ui.switchMode('raw')
    const command = await kernel.exec('structural')

    command.assertSucceeded()
    command.assertNotExitCode(1)
    expect(command.toJSON().result).toBe('ok')
  })

  it('reports positional values as a list in toJSON', async () => {
    class Move extends BaseCommand {
      static override commandName = 'move'
      static override description = 'Two positionals'

      @args.string()
      declare from: string

      @args.string()
      declare to: string

      @flags.boolean()
      declare force: boolean

      override run(): void {}
    }

    const command = await new Kernel().register(Move).exec('move', ['a', 'b', '--force'])
    const snapshot = command.toJSON()

    // Console exposes args as a list; flags stay keyed.
    expect(snapshot.args).toEqual(['a', 'b'])
    expect(snapshot.flags).toEqual({ force: true })
  })

  it('carries the namespace in the metadata', () => {
    class MakeThing extends BaseCommand {
      static override commandName = 'make:thing'
      static override description = 'Namespaced'
      override run(): void {}
    }
    expect(MakeThing.serialize().namespace).toBe('make')

    class Plain extends BaseCommand {
      static override commandName = 'plain'
      static override description = 'No namespace'
      override run(): void {}
    }
    expect(Plain.serialize().namespace).toBeNull()
  })

  it('keeps the table header apart from the data rows', async () => {
    class Report extends BaseCommand {
      static override commandName = 'report2'
      static override description = 'Table with a head'
      override run(): void {
        this.ui.table().head(['Name', 'Email']).row(['Ada', 'ada@x.ch']).render()
      }
    }

    const kernel = new Kernel().register(Report)
    kernel.ui.switchMode('raw')
    const command = await kernel.exec('report2')

    // A row assertion should not have to restate the header.
    command.assertTableRows([['Ada', 'ada@x.ch']])
    expect(kernel.ui.getTableHead()).toEqual(['Name', 'Email'])
  })
})
