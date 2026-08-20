import { describe, expect, it } from 'vitest'
import { BaseCommand } from '../../src/console/BaseCommand.js'
import { args, flags } from '../../src/console/decorators.js'
import { parseArgv } from '../../src/console/parser.js'
import type { ArgumentMetaData, FlagMetaData } from '../../src/console/types.js'
import { ReamError } from '../../src/errors/ReamError.js'

function flag(overrides: Partial<FlagMetaData> & Pick<FlagMetaData, 'propertyName'>): FlagMetaData {
  return {
    type: 'string',
    flagName: overrides.propertyName,
    alias: [],
    required: false,
    ...overrides,
  }
}

function argument(
  overrides: Partial<ArgumentMetaData> & Pick<ArgumentMetaData, 'propertyName'>,
): ArgumentMetaData {
  return {
    type: 'string',
    argumentName: overrides.propertyName,
    required: true,
    ...overrides,
  }
}

describe('parseArgv', () => {
  it('reads a space-separated flag value', () => {
    // The regression that forced apps to write throwaway tsx scripts: the old
    // parser only understood --flag=value, so the email landed in positionals
    // and `email` came back as `true`.
    const parsed = parseArgv(['--email', 'hugo@finefoxy.ch', '--name', 'Hugo Dubois'], {
      flags: [flag({ propertyName: 'email' }), flag({ propertyName: 'name' })],
    })
    expect(parsed.flags).toEqual({ email: 'hugo@finefoxy.ch', name: 'Hugo Dubois' })
  })

  it('reads an inline flag value', () => {
    const parsed = parseArgv(['--email=hugo@finefoxy.ch'], {
      flags: [flag({ propertyName: 'email' })],
    })
    expect(parsed.flags.email).toBe('hugo@finefoxy.ch')
  })

  it('keeps a value containing an equals sign intact', () => {
    const parsed = parseArgv(['--dsn=postgres://u:p@h/db?x=1'], {
      flags: [flag({ propertyName: 'dsn' })],
    })
    expect(parsed.flags.dsn).toBe('postgres://u:p@h/db?x=1')
  })

  it('treats a declared boolean as true and supports --no- negation', () => {
    const meta = [flag({ propertyName: 'force', type: 'boolean' })]
    expect(parseArgv(['--force'], { flags: meta }).flags.force).toBe(true)
    expect(parseArgv(['--no-force'], { flags: meta }).flags.force).toBe(false)
    expect(parseArgv(['--force=false'], { flags: meta }).flags.force).toBe(false)
  })

  it('does not swallow the next token after a boolean flag', () => {
    const parsed = parseArgv(['--force', 'Users'], {
      flags: [flag({ propertyName: 'force', type: 'boolean' })],
      args: [argument({ propertyName: 'name' })],
    })
    expect(parsed.flags.force).toBe(true)
    expect(parsed.args).toEqual(['Users'])
  })

  it('resolves single and grouped aliases', () => {
    const meta = [
      flag({ propertyName: 'resource', type: 'boolean', alias: ['r'] }),
      flag({ propertyName: 'singular', type: 'boolean', alias: ['s'] }),
      flag({ propertyName: 'model', alias: ['m'] }),
    ]
    expect(parseArgv(['-rs', '-m', 'User'], { flags: meta }).flags).toEqual({
      resource: true,
      singular: true,
      model: 'User',
    })
  })

  it('rejects grouping a value-taking flag', () => {
    expect(() =>
      parseArgv(['-rm'], {
        flags: [
          flag({ propertyName: 'resource', type: 'boolean', alias: ['r'] }),
          flag({ propertyName: 'model', alias: ['m'] }),
        ],
      }),
    ).toThrow(/Cannot group/)
  })

  it('coerces numbers and rejects non-numeric input', () => {
    const meta = [flag({ propertyName: 'score', type: 'number' })]
    expect(parseArgv(['--score', '42'], { flags: meta }).flags.score).toBe(42)
    expect(() => parseArgv(['--score', 'abc'], { flags: meta })).toThrow(/expects a number/)
  })

  it('accumulates a repeated array flag', () => {
    const parsed = parseArgv(['--tag', 'a', '--tag=b'], {
      flags: [flag({ propertyName: 'tag', type: 'array' })],
    })
    expect(parsed.flags.tag).toEqual(['a', 'b'])
  })

  it('reports a flag left without its value', () => {
    expect(() =>
      parseArgv(['--email', '--name', 'Hugo'], {
        flags: [flag({ propertyName: 'email' }), flag({ propertyName: 'name' })],
      }),
    ).toThrow(/"--email".*expects a value/)
  })

  it('reports unknown flags unless the command opts out', () => {
    expect(() =>
      parseArgv(['--warm'], { flags: [flag({ propertyName: 'warn', type: 'boolean' })] }),
    ).toThrow(/Unknown flag "--warm"/)
    const parsed = parseArgv(['--warm'], {
      flags: [flag({ propertyName: 'warn', type: 'boolean' })],
      allowUnknownFlags: true,
    })
    expect(parsed.flags.warm).toBe(true)
  })

  it('stops flag parsing after --', () => {
    const parsed = parseArgv(['--', '--not-a-flag'], {
      args: [argument({ propertyName: 'rest', type: 'spread', required: false })],
    })
    expect(parsed.args).toEqual([['--not-a-flag']])
  })

  it('assigns positionals in declaration order and spreads the remainder', () => {
    const parsed = parseArgv(['auth', 'User', 'a', 'b'], {
      args: [
        argument({ propertyName: 'module' }),
        argument({ propertyName: 'name' }),
        argument({ propertyName: 'extras', type: 'spread', required: false }),
      ],
    })
    expect(parsed.args).toEqual(['auth', 'User', ['a', 'b']])
  })

  it('refuses positionals the command never declared', () => {
    // Swallowing them hides a typo: `greet john extra` must not run as `greet john`.
    expect(() =>
      parseArgv(['john', 'extra'], { args: [argument({ propertyName: 'name' })] }),
    ).toThrow(/Unexpected argument "extra"/)

    // The hint travels on the error, not in its message — that is what the user
    // actually reads through prettyPrintError.
    try {
      parseArgv(['nope'], {})
      expect.unreachable('an undeclared positional must be reported')
    } catch (err) {
      expect(err).toBeInstanceOf(ReamError)
      expect((err as ReamError).message).toContain('Unexpected argument "nope"')
      expect((err as ReamError).hint).toContain('takes no positional arguments')
    }

    // A spread argument consumes the tail, so nothing is left over.
    expect(() =>
      parseArgv(['john', 'a', 'b'], {
        args: [
          argument({ propertyName: 'name' }),
          argument({ propertyName: 'rest', type: 'spread', required: false }),
        ],
      }),
    ).not.toThrow()
  })

  it('applies defaults and reports missing required inputs', () => {
    const parsed = parseArgv([], {
      args: [argument({ propertyName: 'name', required: false, default: 'guest' })],
      flags: [flag({ propertyName: 'connection', default: 'sqlite' })],
    })
    expect(parsed.args).toEqual(['guest'])
    expect(parsed.flags.connection).toBe('sqlite')

    expect(() => parseArgv([], { args: [argument({ propertyName: 'name' })] })).toThrow(
      /Missing required argument "name"/,
    )
    expect(() =>
      parseArgv([], { flags: [flag({ propertyName: 'email', required: true })] }),
    ).toThrow(/Missing required flag "--email"/)
  })
})

describe('decorators', () => {
  it('records metadata as statics, dash-casing names', () => {
    class Greet extends BaseCommand {
      @args.string({ description: 'Who to greet' })
      declare userName: string

      @flags.boolean({ alias: 'v' })
      declare veryLoud: boolean

      run(): void {}
    }

    expect(Greet.args).toEqual([
      {
        type: 'string',
        propertyName: 'userName',
        argumentName: 'user-name',
        description: 'Who to greet',
        required: true,
        default: undefined,
      },
    ])
    expect(Greet.flags[0]).toMatchObject({ flagName: 'very-loud', alias: ['v'], type: 'boolean' })
  })

  it('does not leak a subclass input onto its parent', () => {
    class Parent extends BaseCommand {
      @flags.boolean()
      declare force: boolean

      run(): void {}
    }
    class Child extends Parent {
      @flags.string()
      declare model: string
    }

    expect(Parent.flags.map((f) => f.flagName)).toEqual(['force'])
    expect(Child.flags.map((f) => f.flagName)).toEqual(['force', 'model'])
  })

  it('drives the parser end to end', () => {
    class Provision extends BaseCommand {
      @flags.string({ required: true })
      declare email: string

      @flags.string({ default: 'Owner' })
      declare name: string

      run(): void {}
    }

    const parsed = parseArgv(['--email', 'hugo@finefoxy.ch'], {
      flags: Provision.flags,
      commandName: 'provision',
    })
    expect(parsed.flags).toEqual({ email: 'hugo@finefoxy.ch', name: 'Owner' })
  })

  it('reports an empty value, unless the declaration allows it', () => {
    class Strict extends BaseCommand {
      @args.string()
      declare body: string

      @flags.string()
      declare tag: string

      run(): void {}
    }
    class Lenient extends BaseCommand {
      @args.string({ allowEmptyValue: true })
      declare body: string

      @flags.string({ allowEmptyValue: true })
      declare tag: string

      run(): void {}
    }

    // `ream note "$MESSAGE"` with MESSAGE unset is a mistake worth reporting,
    // not an empty note — that is Console's rule, and `allowEmptyValue` opts out.
    expect(() => parseArgv([''], { args: Strict.args, commandName: 'note' })).toThrow(
      /Missing value for argument "body"/,
    )
    expect(() => parseArgv(['--tag'], { flags: Strict.flags, commandName: 'note' })).toThrow(
      /expects a value/,
    )

    expect(parseArgv([''], { args: Lenient.args, commandName: 'note' }).args).toEqual([''])
    expect(parseArgv(['--tag'], { flags: Lenient.flags, commandName: 'note' }).flags).toEqual({
      tag: '',
    })
  })
})
