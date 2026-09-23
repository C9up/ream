/**
 * The `make:` commands.
 *
 * They used to live in the `ream` binary, which meant Rust had to render their
 * stubs — and rendering a stub means evaluating `{{#if resourceful}}`, which is
 * JavaScript. Two renderers is two behaviours waiting to drift, so the
 * generators moved to where the engine already is, the way `make:migration`
 * moved to atlas.
 *
 * One class per command, built from the generator table: Adonis ships a class
 * per command too, and the table is what keeps ten of them from being ten
 * copies. `--force` and the skip-rather-than-clobber rule are Adonis'.
 * `--dry-run` and `--json` are ours, and they are why `@c9up/ream-mcp` can
 * show a plan before anything is written.
 */

import { BaseCommand } from '../BaseCommand.js'
import { args, flags } from '../decorators.js'
import type { CommandClass } from '../types.js'
import Eject from './eject.js'
import { flush, outcomePayload, type PlannedFile, plannedFile } from './flush.js'
import { GENERATORS, type Generator, generatorFor } from './generators.js'
import { nameProblem } from './naming.js'
import { renderStubFor } from './resolve.js'

/** A generator's output, or the message explaining why there is none. */
type Prepared = { file: PlannedFile; published: boolean } | { error: string }

/**
 * Validate the names and render the stub. Shared by the single-kind commands
 * and by `make:module`, so all four files are checked before the first write.
 */
function prepare(
  generator: Generator,
  module: string | undefined,
  name: string,
  extra: { stack?: string; event?: string },
  cwd: string,
): Prepared {
  for (const [label, value] of [
    ['module', module],
    ['name', name],
  ] as const) {
    if (value === undefined) continue
    const problem = nameProblem(value)
    if (problem !== undefined) return { error: `${label} "${value}": ${problem}` }
  }

  const state = generator.state(name, {
    ...(module === undefined ? {} : { module }),
    ...(extra.stack === undefined ? {} : { stack: extra.stack }),
    ...(extra.event === undefined ? {} : { event: extra.event }),
  })

  try {
    const rendered = renderStubFor(generator.kind, state, cwd)
    return {
      file: plannedFile(rendered.path, rendered.contents, cwd),
      published: rendered.published,
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Write the plan and report it — as JSON when asked, as Adonis' action lines
 * otherwise. `--json` prints nothing else: its whole contract is that the last
 * line of stdout is the payload, and a stray warning above it is how that
 * breaks.
 */
function report(
  command: BaseCommand,
  entries: readonly PlannedFile[],
  warnings: readonly string[],
  options: { cwd: string; dryRun: boolean; force: boolean; json: boolean },
): void {
  const outcome = flush(entries, warnings, options)

  if (options.json) {
    process.stdout.write(`${JSON.stringify(outcomePayload(outcome))}\n`)
    return
  }

  if (outcome.status === 'planned') {
    for (const file of outcome.files) {
      // The path AND the contents: a dry run that showed only the path would
      // not answer the question it is asked.
      command.logger.info(`${file.path}${file.exists ? ' (exists)' : ''} — dry run`)
      command.logger.log(file.content)
    }
  } else {
    for (const file of [...outcome.createdFiles, ...outcome.modifiedFiles]) {
      command.logger.action(`create ${file}`).succeeded()
    }
    for (const file of outcome.skippedFiles) {
      command.logger.action(`create ${file}`).skipped('file already exists, use --force')
    }
  }

  for (const warning of warnings) command.logger.warning(warning)
}

/** Build the command class for one generator. */
function makeCommand(generator: Generator): CommandClass {
  class MakeCommand extends BaseCommand {
    static override commandName = generator.commandName
    static override description = generator.description
    // Filesystem only: scaffolding a file must not need a booted application,
    // let alone a reachable database.
    static override options = { startApp: false }

    // `make:controller billing Invoice` — the module comes first, as the
    // binary took it. Declared on the module-scoped commands only, so the
    // others keep a single argument.
    @args.string({
      description: 'Module directory under app/',
      required: generator.moduleScoped,
    })
    declare first: string

    @args.string({ description: 'Name of the generated file', required: false })
    declare second?: string

    @flags.boolean({
      description: 'Forcefully overwrite an existing file',
      alias: 'f',
    })
    declare force?: boolean

    @flags.boolean({
      description: 'Print what would be written, without writing it',
    })
    declare dryRun?: boolean

    @flags.boolean({ description: 'Report the outcome as a single JSON object' })
    declare json?: boolean

    @flags.string({
      description: 'Which stack a middleware registers on: router, server or named',
    })
    declare stack?: string

    @flags.string({ description: 'Event class this listener handles' })
    declare event?: string

    async run(): Promise<void> {
      // Two positionals for a module-scoped generator, one for the rest.
      const module = generator.moduleScoped ? this.first : undefined
      const name = generator.moduleScoped ? (this.second ?? '') : this.first

      if (generator.moduleScoped && this.second === undefined) {
        this.logger.error(`${generator.commandName} takes a module and a name`)
        this.exitCode = 1
        return
      }

      const cwd = process.cwd()
      const prepared = prepare(
        generator,
        module,
        name,
        {
          ...(this.stack === undefined ? {} : { stack: this.stack }),
          ...(this.event === undefined ? {} : { event: this.event }),
        },
        cwd,
      )
      if ('error' in prepared) {
        this.logger.error(prepared.error)
        this.exitCode = 1
        return
      }

      report(this, [prepared.file], [], {
        cwd,
        dryRun: this.dryRun === true,
        force: this.force === true,
        json: this.json === true,
      })

      if (prepared.published && this.json !== true) {
        // Worth saying: the output came from the project's own stub, so a
        // surprise in it is not a bug in ream.
        this.logger.info(`rendered from stubs/make/${generator.kind}.stub`)
      }
    }
  }

  // The class is anonymous to the debugger otherwise, and a stack trace
  // naming `MakeCommand` ten times helps nobody.
  Object.defineProperty(MakeCommand, 'name', {
    value: `Make${generator.kind.charAt(0).toUpperCase()}${generator.kind.slice(1)}`,
  })
  return MakeCommand
}

/**
 * `make:module` — an entity, a controller and a validator in one go.
 *
 * NOT the migration the binary also emitted: a migration is atlas' format and
 * atlas' directory, and ream inventing one would produce a file its own
 * `migration:run` never reads. `make:migration` is atlas' command, and this
 * says so rather than guessing.
 *
 * The three are rendered before any is written, so a stub that fails to render
 * leaves nothing half-generated behind.
 */
class MakeModule extends BaseCommand {
  static override commandName = 'make:module'
  static override description = 'Generate an entity, a controller and a validator'
  static override options = { startApp: false }

  @args.string({ description: 'Module directory under app/' })
  declare module: string

  @args.string({ description: 'Name shared by the generated files' })
  declare name: string

  @flags.boolean({ description: 'Forcefully overwrite existing files', alias: 'f' })
  declare force?: boolean

  @flags.boolean({ description: 'Print what would be written, without writing it' })
  declare dryRun?: boolean

  @flags.boolean({ description: 'Report the outcome as a single JSON object' })
  declare json?: boolean

  async run(): Promise<void> {
    const cwd = process.cwd()
    const entries: PlannedFile[] = []

    for (const kind of ['entity', 'controller', 'validator'] as const) {
      const generator = generatorFor(kind)
      if (generator === undefined) {
        this.logger.error(`no generator for "${kind}"`)
        this.exitCode = 1
        return
      }
      const prepared = prepare(generator, this.module, this.name, {}, cwd)
      if ('error' in prepared) {
        this.logger.error(prepared.error)
        this.exitCode = 1
        return
      }
      entries.push(prepared.file)
    }

    const warnings = [
      // Said, not done: a barrel is the application's file, and appending to it
      // blindly is how an export ends up duplicated.
      `if app/${this.module}/index.ts exists, add the new exports to it yourself`,
      "no migration was generated — that one is atlas': run `ream make:migration`",
    ]

    report(this, entries, warnings, {
      cwd,
      dryRun: this.dryRun === true,
      force: this.force === true,
      json: this.json === true,
    })
  }
}

/** Every `make:` command, built once. */
export const MAKE_COMMANDS: readonly CommandClass[] = [
  ...GENERATORS.map(makeCommand),
  MakeModule,
  Eject,
]
