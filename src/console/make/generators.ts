/**
 * What each `make:` command generates.
 *
 * One table rather than ten near-identical commands: every generator is a
 * name, a stub and the variables that stub reads. The differences that matter
 * — which suffix a class carries, whether the name is snake_cased for the file
 * — live here, in one place, instead of being spread across ten files that
 * drift.
 *
 * The DESTINATION is not here. It is in the stub's own front matter, so an
 * application that publishes `stubs/make/controller.stub` can move the file as
 * well as change its contents.
 */

import type { StubState } from '../../stubs/template.js'
import { ensureSuffix, stripSuffixInsensitive, toPascalCase, toSnakeCase } from './naming.js'

/** Extra input a generator takes beyond the name. */
export interface GeneratorInput {
  /** `app/<module>/…` — where a module-scoped file lands. */
  module?: string
  /** `make:middleware --stack server|router|named`. */
  stack?: string
  /** `make:listener --event OrderShipped`. */
  event?: string
}

export interface Generator {
  /** The stub, under `stubs/make/`. */
  kind: string
  commandName: string
  description: string
  /** Does it take `--module`? */
  moduleScoped: boolean
  /** The variables its stub reads. */
  state(name: string, input: GeneratorInput): StubState
}

/** The shared trio every stub may read. */
function base(name: string, className: string, module: string): StubState {
  return { className, module, name }
}

export const GENERATORS: readonly Generator[] = [
  {
    kind: 'controller',
    commandName: 'make:controller',
    description: 'Generate an HTTP controller',
    moduleScoped: true,
    state: (name, input) =>
      base(name, ensureSuffix(name, 'Controller'), input.module ?? 'controllers'),
  },
  {
    kind: 'service',
    commandName: 'make:service',
    description: 'Generate a service class',
    moduleScoped: true,
    state: (name, input) => base(name, ensureSuffix(name, 'Service'), input.module ?? 'services'),
  },
  {
    kind: 'entity',
    commandName: 'make:entity',
    description: 'Generate an Atlas entity',
    moduleScoped: true,
    state: (name, input) => ({
      // No suffix: an entity is `User`, not `UserEntity`.
      ...base(name, toPascalCase(name), input.module ?? 'entities'),
      tableName: `${toSnakeCase(name)}s`,
    }),
  },
  {
    kind: 'validator',
    commandName: 'make:validator',
    description: 'Generate a Rune validator',
    moduleScoped: true,
    state: (name, input) =>
      base(name, ensureSuffix(name, 'Validator'), input.module ?? 'validators'),
  },
  {
    kind: 'provider',
    commandName: 'make:provider',
    description: 'Generate a service provider',
    moduleScoped: false,
    state: (name) => base(name, ensureSuffix(name, 'Provider'), ''),
  },
  {
    kind: 'command',
    commandName: 'make:command',
    description: 'Generate a console command',
    moduleScoped: false,
    state: (name) => {
      // `app:provision` is the command NAME; the class and the file come from
      // its last segment, or the published stub would generate a command
      // unreachable under the name it was asked for.
      const segments = name.split(':')
      const last = segments[segments.length - 1] ?? name
      return {
        className: toPascalCase(toSnakeCase(last)),
        fileName: toSnakeCase(last),
        name,
      }
    },
  },
  {
    kind: 'middleware',
    commandName: 'make:middleware',
    description: 'Generate an HTTP middleware',
    moduleScoped: false,
    state: (name, input) => {
      const fileName = toSnakeCase(stripSuffixInsensitive(name, 'middleware'))
      const stack = input.stack ?? 'router'
      const importer = `() => import('#middleware/${fileName}_middleware.js')`
      // The line the user pastes into their kernel — different per stack, and
      // wrong in a way that is hard to spot if it is guessed.
      const registration =
        stack === 'server'
          ? `server.use([${importer}])`
          : stack === 'named'
            ? `router.named({ ${fileName}: ${importer} })`
            : `router.use([${importer}])`
      return {
        className: `${toPascalCase(fileName)}Middleware`,
        fileName,
        name,
        registration,
        stack,
      }
    },
  },
  {
    kind: 'event',
    commandName: 'make:event',
    description: 'Generate an event class',
    moduleScoped: false,
    state: (name) => {
      const fileName = toSnakeCase(name)
      return { className: toPascalCase(fileName), fileName, name }
    },
  },
  {
    kind: 'listener',
    commandName: 'make:listener',
    description: 'Generate an event listener',
    moduleScoped: false,
    state: (name, input) => {
      const fileName = toSnakeCase(name)
      const className = toPascalCase(fileName)
      if (input.event === undefined) {
        // Without `--event` there is nothing to type the handler with, and
        // inventing an import would point at a file that does not exist.
        return {
          className,
          fileName,
          name,
          importLine: '',
          eventType: 'unknown',
          registration: `emitter.on(SomeEvent, ${className})`,
        }
      }
      const eventFile = toSnakeCase(input.event)
      const eventClass = toPascalCase(eventFile)
      return {
        className,
        fileName,
        name,
        importLine: `import type ${eventClass} from '#app/events/${eventFile}.js'\n\n`,
        eventType: eventClass,
        registration: `emitter.on(${eventClass}, ${className})`,
      }
    },
  },
]

export function generatorFor(kind: string): Generator | undefined {
  return GENERATORS.find((generator) => generator.kind === kind)
}
