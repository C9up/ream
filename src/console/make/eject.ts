/**
 * `eject` — copy a package's stub into the application so it can be edited.
 *
 * The other half of the override rule: `renderStub` prefers `stubs/<path>`
 * when the application has one, and this is how it gets there. Copied
 * verbatim, front matter included, because the `to:` line is part of what a
 * project may want to change.
 *
 * Adonis' command, name and argument included — `node ace eject make/controller
 * --pkg=@adonisjs/lucid`. `--pkg` reads the package's own `stubsRoot`, which
 * every Ream package exports from its `./stubs` subpath, so ejecting atlas' or
 * warden's templates needs nothing added here.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { BaseCommand } from '../BaseCommand.js'
import { args, flags } from '../decorators.js'
import { GENERATORS } from './generators.js'
import {
  isSafeStubPath,
  PUBLISHED_ROOT,
  REAM_STUBS_ROOT,
  readStub,
  splitFrontMatter,
  stubPathFor,
} from './resolve.js'

/** Every `{{ name }}` a stub reads, so the listing cannot advertise a wrong one. */
function variablesOf(source: string): string[] {
  const found = new Set<string>()
  for (const match of source.matchAll(/\{\{\{?\s*([\w.]+)\s*\}?\}\}/g)) {
    const name = match[1]
    if (name !== undefined) found.add(name)
  }
  return [...found].sort()
}

/** The `stubsRoot` a module exports, when it exports one. */
async function stubsRootFrom(specifier: string): Promise<string | undefined> {
  try {
    const loaded: unknown = await import(specifier)
    if (typeof loaded !== 'object' || loaded === null) return undefined
    const root = (loaded as { stubsRoot?: unknown }).stubsRoot
    return typeof root === 'string' ? root : undefined
  } catch {
    return undefined
  }
}

/**
 * The `stubsRoot` a package exports, or nothing when it exports none.
 *
 * Read from the package rather than guessed from `node_modules/<pkg>/stubs`:
 * a package is free to keep them elsewhere, and only its own export says
 * where. Adonis reads the entrypoint, so that is tried first; the `./stubs`
 * subpath is tried after, because a barrel that also runs in a browser cannot
 * export a filesystem path — which is why Ream packages put it on a subpath.
 */
async function stubsRootOf(pkg: string): Promise<string | undefined> {
  if (pkg === '@c9up/ream') return REAM_STUBS_ROOT
  return (await stubsRootFrom(pkg)) ?? (await stubsRootFrom(`${pkg}/stubs`))
}

/** Every `.stub` under `root`, as paths relative to it. */
function stubsUnder(root: string, prefix = ''): string[] {
  const found: string[] = []
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) found.push(...stubsUnder(root, relative))
    else if (entry.name.endsWith('.stub')) found.push(relative)
  }
  return found.sort()
}

export default class Eject extends BaseCommand {
  static override commandName = 'eject'
  static override description =
    'Copy a package stub into stubs/ so the project can customise what make: generates'
  static override options = { startApp: false }

  @args.string({
    description: 'The stub to copy, e.g. make/controller.stub — omit for a directory or all',
    required: false,
  })
  declare stubPath?: string

  @flags.string({ description: 'Which package to read the stub from' })
  declare pkg?: string

  @flags.boolean({ description: 'List what can be ejected, and the variables each stub reads' })
  declare list?: boolean

  @flags.boolean({ description: 'Overwrite a stub the project already ejected' })
  declare force?: boolean

  async run(): Promise<void> {
    const pkg = this.pkg ?? '@c9up/ream'
    const stubsRoot = await stubsRootOf(pkg)
    if (stubsRoot === undefined || !fs.existsSync(stubsRoot)) {
      this.logger.error(`"${pkg}" ships no stubs (no \`stubsRoot\` on its ./stubs subpath)`)
      this.exitCode = 1
      return
    }

    if (this.list === true) {
      this.#printList(stubsRoot)
      return
    }

    const requested = this.stubPath
    if (requested !== undefined && !isSafeStubPath(requested)) {
      this.logger.error(`unusable stub path: ${requested}`)
      this.exitCode = 1
      return
    }

    // A path with no `.stub` suffix names a directory — `eject make` takes the
    // lot, which is what makes ejecting every generator one command.
    const available = stubsUnder(stubsRoot)
    const selected =
      requested === undefined
        ? available
        : requested.endsWith('.stub')
          ? available.filter((candidate) => candidate === requested)
          : available.filter((candidate) => candidate.startsWith(`${requested}/`))

    if (selected.length === 0) {
      this.logger.error(`"${pkg}" ships no stub matching "${requested ?? ''}"`)
      this.exitCode = 1
      return
    }

    for (const stub of selected) {
      const destination = path.join(process.cwd(), PUBLISHED_ROOT, stub)
      if (fs.existsSync(destination) && this.force !== true) {
        this.logger
          .action(`eject ${PUBLISHED_ROOT}/${stub}`)
          .skipped('already ejected, use --force')
        continue
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      // The shipped one, never the project's copy: ejecting over your own edit
      // with your own edit is a no-op that reads as success.
      fs.writeFileSync(destination, fs.readFileSync(path.join(stubsRoot, stub)))
      this.logger.action(`eject ${PUBLISHED_ROOT}/${stub}`).succeeded()
    }
  }

  /** What each generator reads, taken from the stub rather than a kept list. */
  #printList(stubsRoot: string): void {
    const table = this.ui.table().head(['Stub', 'Variables'])
    const generatorStubs = new Set(GENERATORS.map((generator) => stubPathFor(generator.kind)))
    for (const stub of stubsUnder(stubsRoot)) {
      const { source } = readStub(stubsRoot, stub, path.join(process.cwd(), '__none__'))
      const variables = generatorStubs.has(stub)
        ? variablesOf(splitFrontMatter(source).body).join(', ')
        : ''
      table.row([stub, variables])
    }
    table.render()
  }
}
