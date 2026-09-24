import { describe, expect, it, vi } from 'vitest'
import { BaseCommand } from '../../src/console/BaseCommand.js'
import { Kernel } from '../../src/console/Kernel.js'
import { Prompt } from '../../src/console/prompts.js'
import { runSelection } from '../../src/console/selection.js'

const ENTER = '\r'
const ARROW_DOWN = '\u001B[B'
const SPACE = ' '
const ESCAPE = '\u001B'

/**
 * A keyboard and a screen, so a list can be driven without a terminal.
 *
 * The real one needs raw mode, which a test process has no business turning
 * on — and a pipe throws when asked for it.
 */
class FakeKeyboard {
  readonly #listeners: Array<(chunk: string) => void> = []
  readonly drawn: string[] = []

  readonly stream = {
    isTTY: true,
    setRawMode: () => this.stream,
    resume: () => this.stream,
    pause: () => this.stream,
    on: (event: string, listener: (chunk: string) => void) => {
      if (event === 'data') this.#listeners.push(listener)
      return this.stream
    },
    removeListener: (_event: string, listener: (chunk: string) => void) => {
      const at = this.#listeners.indexOf(listener)
      if (at !== -1) this.#listeners.splice(at, 1)
      return this.stream
    },
  } as unknown as NodeJS.ReadStream

  readonly output = {
    write: (chunk: string) => {
      this.drawn.push(chunk)
      return true
    },
    columns: 80,
  } as unknown as NodeJS.WriteStream

  /** Send a key and let the loop react before the test looks. */
  async press(key: string): Promise<void> {
    for (const listener of [...this.#listeners]) listener(key)
    await new Promise((resolve) => setImmediate(resolve))
  }
}

function silence(): () => void {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  return () => stdout.mockRestore()
}

describe('Prompt — scripted answers (Console traps)', () => {
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
      // Console: `format` shapes the echoed input only, it never changes what the
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
  it('starts the pointer on the default, so enter takes it', async () => {
    // A selection default is an index, and with arrow keys that means the
    // pointer starts there — enter takes whatever it is on.
    const keys = new FakeKeyboard()
    const picked = runSelection({
      title: 'Driver',
      items: [{ label: 'pg' }, { label: 'mysql' }],
      selected: [1],
      input: keys.stream,
      output: keys.output,
    })
    await keys.press(ENTER)

    expect(await picked).toEqual({ kind: 'picked', indexes: [1] })
  })

  it('starts a multiple with the defaults already ticked', async () => {
    const keys = new FakeKeyboard()
    const picked = runSelection({
      title: 'Drivers',
      items: [{ label: 'sqlite' }, { label: 'mysql' }, { label: 'pg' }],
      many: true,
      selected: [0, 2],
      input: keys.stream,
      output: keys.output,
    })
    await keys.press(ENTER)

    expect(await picked).toEqual({ kind: 'picked', indexes: [0, 2] })
  })

  it('walks the list with the arrow keys', async () => {
    const keys = new FakeKeyboard()
    const picked = runSelection({
      title: 'Driver',
      items: [{ label: 'pg' }, { label: 'mysql' }, { label: 'sqlite' }],
      input: keys.stream,
      output: keys.output,
    })
    await keys.press(ARROW_DOWN)
    await keys.press(ARROW_DOWN)
    await keys.press(ENTER)

    expect(await picked).toEqual({ kind: 'picked', indexes: [2] })
  })

  it('wraps round the ends rather than stopping', async () => {
    // A pointer that sticks at the bottom of a long list makes the last items
    // the hardest to reach, which is backwards.
    const keys = new FakeKeyboard()
    const picked = runSelection({
      title: 'Driver',
      items: [{ label: 'pg' }, { label: 'mysql' }],
      input: keys.stream,
      output: keys.output,
    })
    await keys.press('\u001B[A')
    await keys.press(ENTER)

    expect(await picked).toEqual({ kind: 'picked', indexes: [1] })
  })

  it('ticks with space, in the order they were ticked', async () => {
    const keys = new FakeKeyboard()
    const picked = runSelection({
      title: 'Drivers',
      items: [{ label: 'pg' }, { label: 'mysql' }, { label: 'sqlite' }],
      many: true,
      input: keys.stream,
      output: keys.output,
    })
    await keys.press(ARROW_DOWN)
    await keys.press(SPACE)
    await keys.press(ARROW_DOWN)
    await keys.press(SPACE)
    await keys.press(ENTER)

    // The order the user built, not the order of the list.
    expect(await picked).toEqual({ kind: 'picked', indexes: [1, 2] })
  })

  it('unticks what was ticked', async () => {
    const keys = new FakeKeyboard()
    const picked = runSelection({
      title: 'Drivers',
      items: [{ label: 'pg' }, { label: 'mysql' }],
      many: true,
      selected: [0],
      input: keys.stream,
      output: keys.output,
    })
    await keys.press(SPACE)
    await keys.press(ENTER)

    expect(await picked).toEqual({ kind: 'picked', indexes: [] })
  })

  it('narrows as you type, and answers what is left', async () => {
    const keys = new FakeKeyboard()
    const picked = runSelection({
      title: 'Driver',
      items: [{ label: 'postgres' }, { label: 'mysql' }, { label: 'sqlite' }],
      filter: true,
      input: keys.stream,
      output: keys.output,
    })
    // `sq` would also match my-sq-l, which is the point of a substring filter.
    await keys.press('s')
    await keys.press('q')
    await keys.press('l')
    await keys.press('i')
    await keys.press(ENTER)

    expect(await picked).toEqual({ kind: 'picked', indexes: [2] })
  })

  it('takes a letter back with backspace', async () => {
    const keys = new FakeKeyboard()
    const picked = runSelection({
      title: 'Driver',
      items: [{ label: 'postgres' }, { label: 'mysql' }],
      filter: true,
      input: keys.stream,
      output: keys.output,
    })
    await keys.press('z')
    await keys.press('\u007F')
    // Two characters in one chunk: what a fast typist and a paste both send.
    await keys.press('my')
    await keys.press(ENTER)

    expect(await picked).toEqual({ kind: 'picked', indexes: [1] })
  })

  it('answers nothing on a filter that matches nothing', async () => {
    const keys = new FakeKeyboard()
    const picked = runSelection({
      title: 'Driver',
      items: [{ label: 'postgres' }],
      filter: true,
      input: keys.stream,
      output: keys.output,
    })
    await keys.press('zzz')
    await keys.press(ENTER)
    // Still waiting: there is no line under the pointer to take.
    await keys.press('\u007F')
    await keys.press('\u007F')
    await keys.press('\u007F')
    await keys.press(ENTER)

    expect(await picked).toEqual({ kind: 'picked', indexes: [0] })
  })

  it('cancels on escape, which is not an empty answer', async () => {
    const keys = new FakeKeyboard()
    const picked = runSelection({
      title: 'Driver',
      items: [{ label: 'pg' }],
      input: keys.stream,
      output: keys.output,
    })
    await keys.press(ESCAPE)

    expect(await picked).toEqual({ kind: 'cancelled' })
  })

  it('cancels on Ctrl-C, which raw mode raises no signal for', async () => {
    const keys = new FakeKeyboard()
    const picked = runSelection({
      title: 'Driver',
      items: [{ label: 'pg' }],
      input: keys.stream,
      output: keys.output,
    })
    await keys.press('\u0003')

    expect(await picked).toEqual({ kind: 'cancelled' })
  })

  it('shows a window of a long list, around the cursor', async () => {
    const keys = new FakeKeyboard()
    const picked = runSelection({
      title: 'Pick',
      items: Array.from({ length: 30 }, (_, i) => ({ label: `option-${i}` })),
      limit: 5,
      input: keys.stream,
      output: keys.output,
    })
    await keys.press(ARROW_DOWN)
    const frame = keys.drawn.join('')
    await keys.press(ENTER)
    await picked

    // Five lines, not thirty, and it says how many are left.
    expect(frame).toContain('option-1')
    expect(frame).not.toContain('option-20')
    expect(frame).toContain('more')
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

describe('Prompt — Console option contracts', () => {
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
      // Console hands the array to `result` for a multiselect — a per-item call
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
