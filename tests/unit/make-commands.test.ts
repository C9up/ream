/**
 * The `make:` generators, now that they live here.
 *
 * They used to be Rust, which meant the binary had to render their stubs —
 * and rendering one means evaluating `{{#if resourceful}}`, which is
 * JavaScript. What is under test is what moved: the naming conventions, the
 * destination a stub declares, and the application's right to replace both.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Kernel } from '../../src/console/Kernel.js'
import { GENERATORS } from '../../src/console/make/generators.js'
import {
  ensureSuffix,
  nameProblem,
  toPascalCase,
  toSnakeCase,
} from '../../src/console/make/naming.js'
import { renderStubFor } from '../../src/console/make/resolve.js'

describe('make — naming conventions', () => {
  it('adds a suffix once, never twice', () => {
    expect(ensureSuffix('User', 'Controller')).toBe('UserController')
    expect(ensureSuffix('UserController', 'Controller')).toBe('UserController')
  })

  it('splits an acronym where a reader would', () => {
    // The case a one-line regex gets wrong, and the reason this is ported
    // rather than reinvented.
    expect(toSnakeCase('UserProfile')).toBe('user_profile')
    expect(toSnakeCase('HTTPServer')).toBe('http_server')
    expect(toPascalCase('user_profile')).toBe('UserProfile')
    expect(toPascalCase('order-shipped')).toBe('OrderShipped')
  })

  it('refuses a name that would write outside the project', () => {
    // Refused, not sanitised: rewriting it would produce a file somewhere the
    // user did not ask for.
    expect(nameProblem('../../etc/passwd')).toBeTypeOf('string')
    expect(nameProblem('a/b')).toMatch(/path separator/)
    expect(nameProblem('')).toMatch(/empty/)
    expect(nameProblem('x'.repeat(200))).toMatch(/longer than/)
    expect(nameProblem('User')).toBeUndefined()
    // A command name carries a colon, and that is not a path.
    expect(nameProblem('app:provision')).toBeUndefined()
  })
})

describe('make — what each generator produces', () => {
  let project: string

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'ream-make-'))
  })
  afterEach(() => {
    fs.rmSync(project, { recursive: true, force: true })
  })

  it('renders every shipped stub, to a path inside the project', () => {
    // A stub that does not compile, or that declares no destination, fails
    // here rather than on someone's first `make:`.
    for (const generator of GENERATORS) {
      const state = generator.state('Invoice', { module: 'billing' })
      const rendered = renderStubFor(generator.kind, state, project)

      expect(rendered.path, generator.kind).not.toMatch(/^\//)
      expect(rendered.path, generator.kind).not.toContain('..')
      expect(rendered.contents.length, generator.kind).toBeGreaterThan(0)
      // Nothing left unrendered.
      expect(rendered.contents, generator.kind).not.toContain('{{')
    }
  })

  it('names the class the way each generator says', () => {
    const cases: Array<[string, string, string]> = [
      ['controller', 'User', 'UserController'],
      ['service', 'User', 'UserService'],
      ['validator', 'User', 'UserValidator'],
      ['provider', 'Stripe', 'StripeProvider'],
      // An entity is `User`, not `UserEntity`.
      ['entity', 'User', 'User'],
    ]
    for (const [kind, input, expected] of cases) {
      const generator = GENERATORS.find((candidate) => candidate.kind === kind)
      expect(generator, kind).toBeDefined()
      expect(generator?.state(input, {}).className, kind).toBe(expected)
    }
  })

  it('builds a command from its last segment, not from the whole name', () => {
    // `make:command app:provision` must generate a command REACHABLE as
    // `app:provision` — a class called `AppProvision` from the full name was
    // the bug this convention exists to avoid.
    const generator = GENERATORS.find((candidate) => candidate.kind === 'command')
    const state = generator?.state('app:provision', {}) ?? {}
    expect(state.className).toBe('Provision')
    expect(state.fileName).toBe('provision')
    expect(state.name).toBe('app:provision')
  })

  it('writes the registration line the chosen stack actually needs', () => {
    const generator = GENERATORS.find((candidate) => candidate.kind === 'middleware')
    const named = generator?.state('Auth', { stack: 'named' }) ?? {}
    const server = generator?.state('Auth', { stack: 'server' }) ?? {}
    const router = generator?.state('Auth', {}) ?? {}

    expect(named.registration).toContain('router.named(')
    expect(server.registration).toContain('server.use(')
    expect(router.registration).toContain('router.use(')
    // The suffix is dropped from the file name and added to the class.
    expect(named.fileName).toBe('auth')
    expect(named.className).toBe('AuthMiddleware')
  })

  it("prefers the application's published stub", () => {
    // What lets a project change what every `make:service` produces without
    // forking ream — the rule the binary applied, kept.
    const published = path.join(project, 'stubs', 'make')
    fs.mkdirSync(published, { recursive: true })
    fs.writeFileSync(
      path.join(published, 'service.stub'),
      '---\nto: app/{{ module }}/{{ className }}.ts\n---\n// mine: {{ className }}\n',
    )

    const generator = GENERATORS.find((candidate) => candidate.kind === 'service')
    const state = generator?.state('User', { module: 'billing' }) ?? {}
    const rendered = renderStubFor('service', state, project)

    expect(rendered.published).toBe(true)
    expect(rendered.contents).toBe('// mine: UserService\n')
    expect(rendered.path).toBe('app/billing/UserService.ts')
  })

  it('refuses a published stub that writes outside the project', () => {
    const published = path.join(project, 'stubs', 'make')
    fs.mkdirSync(published, { recursive: true })
    fs.writeFileSync(path.join(published, 'service.stub'), '---\nto: ../../escaped.ts\n---\nnope\n')
    expect(() => renderStubFor('service', { className: 'X' }, project)).toThrow(
      /outside the project/,
    )
  })
})

describe('make — registered in the kernel', () => {
  it('ships every generator as a real command', () => {
    const kernel = new Kernel()
    for (const generator of GENERATORS) {
      expect(kernel.hasCommand(generator.commandName), generator.commandName).toBe(true)
    }
    expect(kernel.getNamespaces()).toContain('make')
  })
})

describe('make — running the command', () => {
  let project: string
  let previous: string

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'ream-make-run-'))
    previous = process.cwd()
    process.chdir(project)
  })
  afterEach(() => {
    process.chdir(previous)
    fs.rmSync(project, { recursive: true, force: true })
  })

  it('writes the file where the stub says, from two positionals', async () => {
    // `ream make:controller billing Invoice` — the module comes first, as the
    // binary took it.
    const kernel = new Kernel()
    const command = await kernel.exec('make:controller', ['billing', 'Invoice'])

    expect(command.exitCode).toBe(0)
    const written = path.join(project, 'app/billing/InvoiceController.ts')
    expect(fs.existsSync(written)).toBe(true)
    expect(fs.readFileSync(written, 'utf8')).toContain('InvoiceController')
  })

  it('skips a file that is already there, and overwrites it with --force', async () => {
    // Adonis' rule: a generator that finds the file answers SKIPPED and exits
    // 0. Overwriting someone's work is what `--force` is for, and nothing else.
    const kernel = new Kernel()
    await kernel.exec('make:service', ['billing', 'Invoice'])
    const target = path.join(project, 'app/billing/InvoiceService.ts')
    fs.writeFileSync(target, '// mine')

    const skipped = await kernel.exec('make:service', ['billing', 'Invoice'])
    expect(skipped.exitCode).toBe(0)
    expect(fs.readFileSync(target, 'utf8')).toBe('// mine')

    const forced = await kernel.exec('make:service', ['billing', 'Invoice', '--force'])
    expect(forced.exitCode).toBe(0)
    expect(fs.readFileSync(target, 'utf8')).toContain('InvoiceService')
  })

  it('writes nothing on a dry run', async () => {
    const kernel = new Kernel()
    const command = await kernel.exec('make:provider', ['Stripe', '--dry-run'])

    expect(command.exitCode).toBe(0)
    expect(fs.existsSync(path.join(project, 'providers/StripeProvider.ts'))).toBe(false)
  })

  it('reports a module-scoped command called with one argument', async () => {
    // It used to generate `app/Invoice/<something>` silently.
    const kernel = new Kernel()
    const command = await kernel.exec('make:entity', ['Invoice'])
    expect(command.exitCode).toBe(1)
  })

  it('types the listener against the event it was given', async () => {
    const kernel = new Kernel()
    await kernel.exec('make:listener', ['sendInvoice', '--event', 'orderShipped'])

    const written = fs.readFileSync(path.join(project, 'app/listeners/send_invoice.ts'), 'utf8')
    expect(written).toContain("import type OrderShipped from '#app/events/order_shipped.js'")
    expect(written).toContain('handle(event: OrderShipped)')
  })
})

describe('make:module', () => {
  let project: string
  let previous: string

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'ream-make-module-'))
    previous = process.cwd()
    process.chdir(project)
  })
  afterEach(() => {
    process.chdir(previous)
    fs.rmSync(project, { recursive: true, force: true })
  })

  it('generates the three files that share the name', async () => {
    const command = await new Kernel().exec('make:module', ['billing', 'Invoice'])

    expect(command.exitCode).toBe(0)
    for (const file of [
      'app/billing/Invoice.ts',
      'app/billing/InvoiceController.ts',
      'app/billing/InvoiceValidator.ts',
    ]) {
      expect(fs.existsSync(path.join(project, file)), file).toBe(true)
    }
    // NOT a migration: that is atlas' format and atlas' directory.
    expect(fs.existsSync(path.join(project, 'database'))).toBe(false)
  })

  it('leaves a file that is already there and writes the others', async () => {
    fs.mkdirSync(path.join(project, 'app/billing'), { recursive: true })
    fs.writeFileSync(path.join(project, 'app/billing/Invoice.ts'), '// mine')

    const command = await new Kernel().exec('make:module', ['billing', 'Invoice'])

    expect(command.exitCode).toBe(0)
    expect(fs.readFileSync(path.join(project, 'app/billing/Invoice.ts'), 'utf8')).toBe('// mine')
    // The refusal is per file: the two that were free still got written.
    expect(fs.existsSync(path.join(project, 'app/billing/InvoiceController.ts'))).toBe(true)
    expect(fs.existsSync(path.join(project, 'app/billing/InvoiceValidator.ts'))).toBe(true)
  })

  it('renders every file before it writes the first', async () => {
    // A stub that cannot render must not leave two thirds of a module behind.
    fs.mkdirSync(path.join(project, 'stubs/make'), { recursive: true })
    fs.writeFileSync(
      path.join(project, 'stubs/make/validator.stub'),
      '---\nto: ../escape.ts\n---\n',
    )

    const command = await new Kernel().exec('make:module', ['billing', 'Invoice'])

    expect(command.exitCode).toBe(1)
    expect(fs.existsSync(path.join(project, 'app/billing/Invoice.ts'))).toBe(false)
  })
})

describe('eject', () => {
  let project: string
  let previous: string

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'ream-eject-'))
    previous = process.cwd()
    process.chdir(project)
  })
  afterEach(() => {
    process.chdir(previous)
    fs.rmSync(project, { recursive: true, force: true })
  })

  it('copies a stub into the project, front matter included', async () => {
    // The `to:` line is part of what a project may want to change, so it is
    // copied rather than stripped.
    const command = await new Kernel().exec('eject', ['make/service.stub'])

    expect(command.exitCode).toBe(0)
    const ejected = fs.readFileSync(path.join(project, 'stubs/make/service.stub'), 'utf8')
    expect(ejected.startsWith('---')).toBe(true)
    expect(ejected).toContain('to: app/{{ module }}/{{ className }}.ts')
  })

  it('takes a whole directory', async () => {
    const command = await new Kernel().exec('eject', ['make'])

    expect(command.exitCode).toBe(0)
    for (const generator of GENERATORS) {
      const ejected = path.join(project, 'stubs/make', `${generator.kind}.stub`)
      expect(fs.existsSync(ejected), generator.kind).toBe(true)
    }
  })

  it('and the generator then renders from it', async () => {
    const kernel = new Kernel()
    await kernel.exec('eject', ['make/service.stub'])
    fs.writeFileSync(
      path.join(project, 'stubs/make/service.stub'),
      '---\nto: app/{{ module }}/{{ className }}.ts\n---\n// edited\n',
    )
    await kernel.exec('make:service', ['billing', 'Invoice'])

    expect(fs.readFileSync(path.join(project, 'app/billing/InvoiceService.ts'), 'utf8')).toBe(
      '// edited\n',
    )
  })

  it('does not replace an edited stub without --force', async () => {
    const kernel = new Kernel()
    await kernel.exec('eject', ['make/service.stub'])
    fs.writeFileSync(path.join(project, 'stubs/make/service.stub'), '// mine')

    await kernel.exec('eject', ['make/service.stub'])
    expect(fs.readFileSync(path.join(project, 'stubs/make/service.stub'), 'utf8')).toBe('// mine')

    await kernel.exec('eject', ['make/service.stub', '--force'])
    expect(fs.readFileSync(path.join(project, 'stubs/make/service.stub'), 'utf8')).toContain('to:')
  })

  it('reports a stub the package does not ship', async () => {
    const command = await new Kernel().exec('eject', ['nope'])
    expect(command.exitCode).toBe(1)
  })

  it('refuses a path that would read outside the stubs root', async () => {
    const command = await new Kernel().exec('eject', ['../../../etc/passwd'])
    expect(command.exitCode).toBe(1)
  })

  it('reports a package that ships none', async () => {
    const command = await new Kernel().exec('eject', ['make/service.stub', '--pkg', '@c9up/nope'])
    expect(command.exitCode).toBe(1)
  })
})

describe('make — the --json outcome', () => {
  let project: string
  let previous: string
  let written: string[]

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'ream-make-json-'))
    previous = process.cwd()
    process.chdir(project)
    written = []
    // The contract is about stdout, so stdout is what the test reads.
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
      return true
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    process.chdir(previous)
    fs.rmSync(project, { recursive: true, force: true })
  })

  /** What `@c9up/ream-mcp` reads: the last non-empty line of stdout. */
  function trailingJson(): Record<string, unknown> {
    const lines = written
      .join('')
      .split('\n')
      .filter((line) => line.trim() !== '')
    const last = lines.at(-1)
    expect(last, 'nothing was printed').toBeTypeOf('string')
    return JSON.parse(last ?? '')
  }

  it('prints the plan, and only the plan, on a dry run', async () => {
    const command = await new Kernel().exec('make:provider', ['Stripe', '--dry-run', '--json'])

    expect(command.exitCode).toBe(0)
    const payload = trailingJson()
    expect(payload).toEqual({
      files: [
        {
          path: 'providers/StripeProvider.ts',
          content: expect.stringContaining('StripeProvider'),
          exists: false,
        },
      ],
      warnings: [],
    })
    // One object, nothing else: a stray line above it is how the parser breaks.
    expect(written.join('').trim().split('\n')).toHaveLength(1)
  })

  it('names what it created, modified and skipped', async () => {
    const kernel = new Kernel()
    await kernel.exec('make:provider', ['Stripe'])
    written = []

    await kernel.exec('make:provider', ['Stripe', '--json'])
    expect(trailingJson()).toEqual({
      createdFiles: [],
      modifiedFiles: [],
      skippedFiles: ['providers/StripeProvider.ts'],
      warnings: [],
    })

    written = []
    await kernel.exec('make:provider', ['Stripe', '--json', '--force'])
    expect(trailingJson()).toEqual({
      createdFiles: [],
      modifiedFiles: ['providers/StripeProvider.ts'],
      skippedFiles: [],
      warnings: [],
    })
  })

  it("carries make:module's warnings", async () => {
    await new Kernel().exec('make:module', ['billing', 'Invoice', '--json'])

    const payload = trailingJson()
    expect(payload.createdFiles).toHaveLength(3)
    expect(payload.warnings).toEqual([
      expect.stringContaining('index.ts'),
      expect.stringContaining('make:migration'),
    ])
  })
})
