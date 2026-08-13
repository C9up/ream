/**
 * The static and instance surface Ace's `BaseCommand` exposes.
 *
 * Checked against @adonisjs/ace 14.1.0: `boot`, `getParserOptions`, `validate`,
 * `hydrate`, `exec` and the instance getters are part of the class, not of the
 * kernel — code ported from Adonis calls them directly.
 */

import { describe, expect, it } from 'vitest'
import { BaseCommand } from '../../src/console/BaseCommand.js'
import { args, flags } from '../../src/console/decorators.js'
import { Kernel } from '../../src/console/Kernel.js'
import { parseArgv } from '../../src/console/parser.js'

class Greet extends BaseCommand {
  static override commandName = 'greet'
  static override description = 'Greets someone'

  @args.string({ description: 'Who to greet' })
  declare name: string

  @flags.boolean({ alias: ['l'], description: 'Shout it' })
  declare loud: boolean

  @flags.number({ default: 1 })
  declare times: number

  run(): string {
    return this.loud ? this.name.toUpperCase() : this.name
  }
}

describe('BaseCommand — static contract', () => {
  it('gives each class its own declarations', () => {
    class Child extends Greet {
      static override commandName = 'greet:again'
    }
    Child.defineFlag('extra', { type: 'boolean' })

    // The whole point of boot(): without an own copy, `Child` would have
    // appended to the array `Greet` declared.
    expect(Child.flags.map((flag) => flag.flagName)).toContain('extra')
    expect(Greet.flags.map((flag) => flag.flagName)).not.toContain('extra')
    expect(Child.booted).toBe(true)
  })

  it('describes how its inputs are parsed', () => {
    const { flagsParserOptions, argumentsParserOptions } = Greet.getParserOptions()

    expect(flagsParserOptions.all).toEqual(['loud', 'times'])
    expect(flagsParserOptions.boolean).toEqual(['loud'])
    expect(flagsParserOptions.number).toEqual(['times'])
    expect(flagsParserOptions.alias).toEqual({ loud: ['l'] })
    expect(flagsParserOptions.default).toEqual({ times: 1 })
    expect(argumentsParserOptions).toEqual([
      { type: 'string', default: undefined, parse: undefined },
    ])
  })

  it('merges the parser options it is given', () => {
    const { flagsParserOptions } = Greet.getParserOptions({ count: ['verbose'] })
    expect(flagsParserOptions.count).toEqual(['verbose'])
  })

  it('validates an input built by hand', () => {
    // Ace's use case: nothing here has been through a parser.
    expect(() => Greet.validate({ args: [], flags: {}, unknownFlags: [] })).toThrow(
      /Missing required argument "name"/,
    )
    expect(() => Greet.validate({ args: ['Ada'], flags: {}, unknownFlags: ['nope'] })).toThrow(
      /Unknown flag "--nope"/,
    )
    expect(() => Greet.validate({ args: ['Ada'], flags: {}, unknownFlags: [] })).not.toThrow()
    // The keyed form too — that is what `this.parsed.args` holds.
    expect(() => Greet.validate({ args: { name: 'Ada' }, unknownFlags: [] })).not.toThrow()
  })

  it('validates the flags too, not only the arguments', () => {
    class Deploy extends BaseCommand {
      static override commandName = 'deploy'
      static override description = 'Deploys'

      @flags.string({ required: true })
      declare target: string

      @flags.number()
      declare retries: number

      run(): void {}
    }

    expect(() => Deploy.validate({ args: [], flags: {} })).toThrow(
      /Missing required flag "--target"/,
    )
    expect(() => Deploy.validate({ args: [], flags: { target: '' } })).toThrow(
      /Missing value for flag "--target"/,
    )
    expect(() =>
      Deploy.validate({ args: [], flags: { target: 'prod', retries: Number.NaN } }),
    ).toThrow(/Flag "--retries" for "deploy" expects a number/)
    expect(() => Deploy.validate({ args: [], flags: { target: 'prod' } })).not.toThrow()
  })

  it('refuses an argument order that can never be satisfied', () => {
    class AfterSpread extends BaseCommand {
      static override commandName = 'after:spread'
      static override description = 'Broken'
      run(): void {}
    }
    AfterSpread.defineArgument('files', { type: 'spread', required: false })
    expect(() => AfterSpread.defineArgument('target')).toThrow(/after the spread argument "files"/)

    class AfterOptional extends BaseCommand {
      static override commandName = 'after:optional'
      static override description = 'Broken'
      run(): void {}
    }
    AfterOptional.defineArgument('nickname', { required: false })
    // Reaching it would mean passing the optional one first, so "required" is
    // not something the CLI could enforce.
    expect(() => AfterOptional.defineArgument('name')).toThrow(/after the optional "nickname"/)
  })

  it('accepts an empty value when the declaration allows it', () => {
    class Note extends BaseCommand {
      static override commandName = 'note'
      static override description = 'Notes'

      @args.string({ allowEmptyValue: true })
      declare body: string

      @flags.string({ allowEmptyValue: true })
      declare tag: string

      run(): void {}
    }

    // Ace's `allowEmptyValue`: without it both of these are reported.
    expect(() => Note.validate({ args: [''], flags: { tag: '' } })).not.toThrow()

    class Strict extends BaseCommand {
      static override commandName = 'strict'
      static override description = 'Strict'

      @args.string()
      declare body: string

      run(): void {}
    }
    expect(() => Strict.validate({ args: [''] })).toThrow(/Missing value for argument "body"/)
  })

  it('carries every option through the programmatic declaration too', () => {
    class Note extends BaseCommand {
      static override commandName = 'note:defined'
      static override description = 'Declared without decorators'
      run(): void {}
    }
    Note.defineArgument('body', { allowEmptyValue: true })
    Note.defineFlag('tag', { type: 'string', allowEmptyValue: true })

    // `defineArgument` / `defineFlag` exist for packages that must not import
    // the decorators, so an option honoured on one path and dropped on the
    // other makes that path quietly stricter.
    expect(Note.args[0]?.allowEmptyValue).toBe(true)
    expect(Note.flags[0]?.allowEmptyValue).toBe(true)
    expect(() => Note.validate({ args: [''], flags: { tag: '' } })).not.toThrow()
    expect(parseArgv([''], { args: Note.args, commandName: 'note:defined' }).args).toEqual([''])
  })

  it('reads a keyed input by property name, not by key order', () => {
    class Move extends BaseCommand {
      static override commandName = 'move'
      static override description = 'Moves'

      @args.string()
      declare from: string

      @args.string()
      declare to: string

      run(): void {}
    }

    // Keys in the reverse order of the declarations: reading them through
    // Object.values() would validate "to" against "from".
    expect(() => Move.validate({ args: { to: 'b', from: 'a' } })).not.toThrow()
    expect(() => Move.validate({ args: { to: 'b' } })).toThrow(/Missing required argument "from"/)
  })

  it('reports a single-character unknown flag with one dash', () => {
    expect(() => Greet.validate({ args: ['Ada'], unknownFlags: ['x'] })).toThrow(/"-x"/)
  })

  it('accepts an unknown flag when the command allows them', () => {
    class Proxied extends BaseCommand {
      static override commandName = 'proxied'
      static override description = 'Forwards anything'
      static override options = { allowUnknownFlags: true }
      run(): void {}
    }
    expect(() => Proxied.validate({ args: [], unknownFlags: ['anything'] })).not.toThrow()
  })
})

describe('BaseCommand — instance contract', () => {
  it('hydrates the parsed values onto its properties, once', () => {
    const command = new (class extends Greet {})()
    Object.assign(command, { parsed: { args: { name: 'Ada' }, flags: { loud: true } } })

    command.hydrate()
    expect(command.name).toBe('Ada')

    // Idempotent: a ported command calling it again must not recompute.
    Object.assign(command, { parsed: { args: { name: 'Grace' }, flags: {} } })
    command.hydrate()
    expect(command.name).toBe('Ada')
  })

  it('hydrates an Ace-shaped input, where positionals are a list', () => {
    const command = new (class extends Greet {})()
    // Ace hands `args` as a list and keys flags by their CLI name. Copying the
    // bag would have set `this[0]` and left `this.name` undefined.
    Object.assign(command, { parsed: { args: ['Ada'], flags: { loud: true } } })

    command.hydrate()
    expect(command.name).toBe('Ada')
    expect(command.loud).toBe(true)
  })

  it('runs itself through exec(), recording the outcome', async () => {
    const command = new (class extends Greet {})()
    Object.assign(command, { parsed: { args: { name: 'Ada' }, flags: { loud: true } } })

    await expect(command.exec()).resolves.toBe('ADA')
    expect(command.result).toBe('ADA')
    expect(command.exitCode).toBe(0)
  })

  it('rethrows from exec() while recording the failure', async () => {
    class Boom extends BaseCommand {
      static override commandName = 'boom'
      static override description = 'Fails'
      run(): never {
        throw new Error('nope')
      }
    }
    const command = new (class extends Boom {})()
    Object.assign(command, { parsed: { args: {}, flags: {} } })

    // Unlike the kernel, which reports the failure on the instance, Ace's
    // instance-level exec() rethrows.
    await expect(command.exec()).rejects.toThrow('nope')
    expect(command.exitCode).toBe(1)
    expect(command.error).toBeInstanceOf(Error)
  })

  it('exposes its statics from the instance', () => {
    Greet.boot()
    const command = new (class extends Greet {})()

    // Read off the instance, not the class — that is how Ace code reads them.
    // `exec()` deliberately does not promise these: a command declared
    // structurally by an agnostic package has no getters, and a type claiming
    // otherwise would be false for it.
    expect(command.commandName).toBe('greet')
    expect(command.args.map((arg) => arg.argumentName)).toEqual(['name'])
    expect(command.flags.map((flag) => flag.flagName)).toEqual(['loud', 'times'])
    expect(command.options).toEqual({ staysAlive: false, allowUnknownFlags: false })
  })

  it('still runs through the kernel with everything hydrated', async () => {
    const command = await new Kernel().register(Greet).exec('greet', ['Ada', '--loud'])

    // The kernel calls hydrate() rather than assigning the values itself.
    expect(command.result).toBe('ADA')
    command.assertSucceeded()
  })
})
