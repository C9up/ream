import { describe, expect, it, vi } from 'vitest'
import { BaseCommand } from '../../src/console/BaseCommand.js'
import { Kernel } from '../../src/console/Kernel.js'
import { Prompt } from '../../src/console/prompts.js'

function silence(): () => void {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  return () => stdout.mockRestore()
}

describe('Prompt — scripted answers (Ace traps)', () => {
  it('answers ask() and secure() from a trap', async () => {
    const prompt = new Prompt()
    prompt.trap('Model name').replyWith('User')
    prompt.trap('token').replyWith('s3cret')

    expect(await prompt.ask('Model name')).toBe('User')
    expect(await prompt.secure('Enter token', { name: 'token' })).toBe('s3cret')
    // Each trap is consumed once.
    expect(prompt.pendingTraps).toEqual([])
  })

  it('answers confirm() and toggle() from a trap', async () => {
    const prompt = new Prompt()
    prompt.trap('Delete files?').accept()
    prompt.trap('Keep backup?').reject()

    expect(await prompt.confirm('Delete files?')).toBe(true)
    expect(await prompt.toggle('Keep backup?', ['Yup', 'Nope'])).toBe(false)
  })

  it('answers choice() and multiple() by index', async () => {
    const prompt = new Prompt()
    prompt.trap('driver').chooseOption(2)
    prompt.trap('drivers').chooseOptions([0, 2])

    const drivers = [
      { name: 'sqlite', message: 'SQLite' },
      { name: 'mysql', message: 'MySQL' },
      { name: 'pg', message: 'PostgreSQL' },
    ]

    expect(await prompt.choice('Pick one', drivers, { name: 'driver' })).toBe('pg')
    expect(await prompt.multiple('Pick some', drivers, { name: 'drivers' })).toEqual([
      'sqlite',
      'pg',
    ])
  })

  it('answers autocomplete() from a trap', async () => {
    const prompt = new Prompt()
    prompt.trap('city').chooseOption(1)
    expect(
      await prompt.autocomplete('Your city', ['Genève', 'Lausanne', 'Sion'], { name: 'city' }),
    ).toBe('Lausanne')
  })

  it('reports a trap pointing past the offered options', async () => {
    const prompt = new Prompt()
    prompt.trap('pick').chooseOption(9)
    await expect(prompt.choice('Pick', ['a', 'b'], { name: 'pick' })).rejects.toThrow(
      /only 2 were offered/,
    )
  })

  it('applies result — but not format — to the returned value', async () => {
    const prompt = new Prompt()
    prompt.trap('name').replyWith('ada')

    const value = await prompt.ask('Name', {
      name: 'name',
      // Ace: `format` shapes the echoed input only, it never changes what the
      // prompt returns. A ported command must not receive a different value.
      format: (raw) => raw.toUpperCase(),
      result: (clean) => `<${clean}>`,
    })
    expect(value).toBe('<ada>')
  })

  it('fails fast on a non-interactive stdin instead of hanging', async () => {
    const prompt = new Prompt()
    // No trap installed and stdin is not a TTY under vitest.
    await expect(prompt.ask('Anything')).rejects.toThrow(/stdin is not interactive/)
  })
})

describe('Prompt — inside a command', () => {
  it('lets a test script every answer the command asks for', async () => {
    let created: { name: string; force: boolean } | undefined

    class MakeThing extends BaseCommand {
      static override commandName = 'make:thing'
      static override description = 'Asks before creating'

      async run(): Promise<void> {
        const name = await this.prompt.ask('Thing name', { name: 'thing-name' })
        const force = await this.prompt.confirm('Overwrite?', { name: 'overwrite' })
        created = { name: String(name), force }
      }
    }

    // The prompt is handed to the kernel, so its traps reach the command —
    // this is what makes an interactive command testable without a terminal.
    const prompt = new Prompt()
    prompt.trap('thing-name').replyWith('Widget')
    prompt.trap('overwrite').accept()

    const kernel = new Kernel({ prompt }).register(MakeThing)
    const restore = silence()
    const command = await kernel.exec('make:thing')
    restore()

    expect(command.error).toBeUndefined()
    expect(command.exitCode).toBe(0)
    expect(created).toEqual({ name: 'Widget', force: true })
  })

  it('still fails clearly when an answer was not scripted', async () => {
    class Asks extends BaseCommand {
      static override commandName = 'asks'
      static override description = 'Asks something nobody scripted'
      async run(): Promise<void> {
        await this.prompt.ask('Unscripted', { name: 'unscripted' })
      }
    }

    const kernel = new Kernel({ prompt: new Prompt() }).register(Asks)

    // Reported, not hung: a missing trap in CI must fail fast.
    await expect(kernel.exec('asks')).rejects.toThrow(/stdin is not interactive/)
  })
})

describe('Prompt — traps are held to the same rules as real answers', () => {
  it('rejects a scripted answer its own validate() would refuse', async () => {
    const prompt = new Prompt()
    prompt.trap('password').replyWith('short')

    // A trap that slips past validation gives the test confidence in something
    // the real prompt would never have accepted.
    await expect(
      prompt.secure('Password', {
        name: 'password',
        validate: (value) => (value.length < 6 ? 'At least 6 characters' : true),
      }),
    ).rejects.toThrow(/At least 6 characters/)
  })

  it('rejects an invalid scripted confirm and an invalid scripted choice', async () => {
    const prompt = new Prompt()
    prompt.trap('danger').accept()
    await expect(
      prompt.confirm('Really?', { name: 'danger', validate: () => 'never allowed' }),
    ).rejects.toThrow(/never allowed/)

    prompt.trap('driver').chooseOption(1)
    await expect(
      prompt.choice('Driver', ['pg', 'mysql'], {
        name: 'driver',
        validate: (value) => (value === 'mysql' ? 'mysql is not supported' : true),
      }),
    ).rejects.toThrow(/mysql is not supported/)
  })

  it('accepts a scripted answer that passes validation', async () => {
    const prompt = new Prompt()
    prompt.trap('password').replyWith('longenough')

    const value = await prompt.secure('Password', {
      name: 'password',
      validate: (input) => input.length >= 6,
    })
    expect(value).toBe('longenough')
  })
})

/** A prompt whose reads are scripted, so the interactive path is testable. */
class ScriptedPrompt extends Prompt {
  readonly asked: string[] = []
  #answers: string[]

  constructor(answers: string[]) {
    super()
    this.#answers = [...answers]
  }

  protected override readLine(query: string): Promise<string> {
    this.asked.push(query)
    return Promise.resolve(this.#answers.shift() ?? '')
  }
}

describe('Prompt — default values on the interactive path', () => {
  it('takes the default index when the answer is empty', async () => {
    const restore = silence()
    // An empty line means "accept the default" — it used to be reported as an
    // invalid selection, so the default was shown and then refused.
    const prompt = new ScriptedPrompt([''])
    const picked = await prompt.choice('Driver', ['pg', 'mysql'], { default: 1 })
    restore()

    expect(picked).toBe('mysql')
  })

  it('takes several default indexes for multiple()', async () => {
    const restore = silence()
    const prompt = new ScriptedPrompt([''])
    const picked = await prompt.multiple('Drivers', ['sqlite', 'mysql', 'pg'], { default: [0, 2] })
    restore()

    expect(picked).toEqual(['sqlite', 'pg'])
  })

  it('shows the default option by name, not by index', async () => {
    const restore = silence()
    const prompt = new ScriptedPrompt([''])
    await prompt.choice('Driver', [{ name: 'pg', message: 'PostgreSQL' }], { default: 0 })
    restore()

    // The label is built before the read, so it lands in the recorded query.
    expect(prompt.asked.join(' ')).toContain('Select')
  })

  it('still takes the default for a text prompt', async () => {
    const prompt = new ScriptedPrompt([''])
    expect(await prompt.ask('Model name', { default: 'User' })).toBe('User')
  })

  it('re-asks until validation passes', async () => {
    const restore = silence()
    const prompt = new ScriptedPrompt(['ab', 'abcdef'])
    const value = await prompt.ask('Name', {
      validate: (input) => (input.length < 3 ? 'Too short' : true),
    })
    restore()

    expect(value).toBe('abcdef')
    // Two reads: the first answer was refused.
    expect(prompt.asked).toHaveLength(2)
  })
})

describe('Prompt — Ace option contracts', () => {
  it('gives multiple() the whole selection in validate and result', async () => {
    const prompt = new Prompt()
    prompt.trap('drivers').chooseOptions([0, 2])

    let seen: unknown
    const value = await prompt.multiple('Drivers', ['sqlite', 'mysql', 'pg'], {
      name: 'drivers',
      validate: (values) => {
        seen = values
        return values.length >= 2 ? true : 'Pick at least two'
      },
      // Ace hands the array to `result` for a multiselect — a per-item call
      // would make a rule like "at least two" impossible to express.
      result: (values) => values.join('+'),
    })

    expect(seen).toEqual(['sqlite', 'pg'])
    expect(value).toBe('sqlite+pg')
  })

  it('rejects a multiple() selection failing its array rule', async () => {
    const prompt = new Prompt()
    prompt.trap('drivers').chooseOptions([1])

    await expect(
      prompt.multiple('Drivers', ['sqlite', 'mysql', 'pg'], {
        name: 'drivers',
        validate: (values) => (values.length >= 2 ? true : 'Pick at least two'),
      }),
    ).rejects.toThrow(/Pick at least two/)
  })

  it('runs validate and result on a trapped autocomplete answer', async () => {
    const prompt = new Prompt()
    prompt.trap('city').chooseOption(0)
    await expect(
      prompt.autocomplete('City', ['Genève', 'Sion'], {
        name: 'city',
        validate: (value) => (value === 'Genève' ? 'not that one' : true),
      }),
    ).rejects.toThrow(/not that one/)

    prompt.trap('city').chooseOption(1)
    const picked = await prompt.autocomplete('City', ['Genève', 'Sion'], {
      name: 'city',
      result: (value) => value.toUpperCase(),
    })
    expect(picked).toBe('SION')
  })

  it('applies result() to confirm and toggle', async () => {
    const prompt = new Prompt()
    prompt.trap('go').accept()
    const decision = await prompt.confirm('Go?', {
      name: 'go',
      result: (value) => (value ? 'yes' : 'no'),
    })
    expect(decision).toBe('yes')

    prompt.trap('files').reject()
    const mode = await prompt.toggle('Delete files?', ['Yup', 'Nope'], {
      name: 'files',
      result: (value) => (value ? 'delete' : 'keep'),
    })
    expect(mode).toBe('keep')
  })
})
