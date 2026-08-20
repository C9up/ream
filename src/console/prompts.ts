/**
 * Interactive prompts (Console / `@poppinss/prompts` surface).
 *
 * Dependency-free, which sets one deliberate boundary: selection prompts are
 * answered by typing a number or a name, not by arrow-key navigation. Doing
 * that properly means raw mode, cursor control and redraw handling — a terminal
 * widget toolkit, which is what enquirer is. Everything else matches Console: the
 * method names, the option bag (`validate` / `default` / `hint` / `name` /
 * `result` / `format`), and the trap API that makes prompts testable.
 */

import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline'
import { ReamError } from '../errors/ReamError.js'
import { colourise } from './ui.js'

/** A selectable option — a bare string, or a value with its display text. */
export type PromptChoice = string | { name: string; message?: string; hint?: string }

/**
 * Options for the selection prompts.
 *
 * `default` is an INDEX here, not a value — that is how Adonis spells it for
 * `choice` / `multiple` / `autocomplete`.
 */
export interface SelectPromptOptions extends Omit<PromptOptions, 'default'> {
  default?: number | readonly number[]
}

/**
 * Options for `multiple()`.
 *
 * `validate` and `result` receive the whole selection, not each item: the
 * prompt's value IS the array, and per-item calls would make a rule like "pick
 * at least two" impossible to express.
 */
export interface MultiplePromptOptions
  extends Omit<SelectPromptOptions, 'validate' | 'result' | 'format'> {
  validate?: (values: string[]) => boolean | string | Promise<boolean | string>
  result?: (values: string[]) => unknown
}

export interface PromptOptions<T = string> {
  /** Used when the answer is empty. */
  default?: T
  /** Identifies the prompt for {@link Prompt.trap}. Defaults to the message. */
  name?: string
  /** Shown next to the question. */
  hint?: string
  /** Return `true` to accept, or a string describing what is wrong. */
  validate?: (value: T) => boolean | string | Promise<boolean | string>
  /** Transforms the value that is returned. */
  result?: (value: T) => unknown
  /**
   * Formats what is echoed as the user types — display only.
   *
   * It does NOT change the value the prompt returns: Console documents it as
   * "affecting only the CLI output", and treating it as a transform would make
   * a ported command receive a different value. Use `result` to transform.
   */
  format?: (value: T) => T
}

/**
 * Scripted answer builder — Console's `prompt.trap(name)`.
 *
 * Without it a command that asks anything is untestable: the test would either
 * hang on a prompt or need a fake terminal.
 */
export class PromptTrap {
  readonly #install: (value: unknown) => void

  constructor(install: (value: unknown) => void) {
    this.#install = install
  }

  /** Answer a text/secure prompt with this value. */
  replyWith(value: string): void {
    this.#install(value)
  }

  /** Answer a confirm/toggle prompt with yes. */
  accept(): void {
    this.#install(true)
  }

  /** Answer a confirm/toggle prompt with no. */
  reject(): void {
    this.#install(false)
  }

  /** Pick the option at this index (choice / autocomplete). */
  chooseOption(index = 0): void {
    this.#install({ index })
  }

  /** Pick these indexes (multiple). */
  chooseOptions(indexes: readonly number[]): void {
    this.#install({ indexes: [...indexes] })
  }
}

/**
 * Options for `confirm` / `toggle`. `result` may map the boolean to something
 * else, which is why the return type follows it (Console documents `result` for
 * every prompt).
 */
export interface BooleanPromptOptions<R = boolean>
  extends Omit<PromptOptions<boolean>, 'result' | 'format'> {
  result?: (value: boolean) => R
}

/** The slice of the options the validation helpers need. */
interface ValidatableOptions<T> {
  validate?: (value: T) => boolean | string | Promise<boolean | string>
}

export class Prompt {
  readonly #traps = new Map<string, unknown>()

  /**
   * Script the next answer for the prompt registered under `name`
   * (`options.name`, defaulting to the message).
   */
  trap(name: string): PromptTrap {
    return new PromptTrap((value) => {
      this.#traps.set(name, value)
    })
  }

  /** Traps that were installed but never reached — useful in assertions. */
  get pendingTraps(): string[] {
    return [...this.#traps.keys()]
  }

  async ask(message: string, options: PromptOptions = {}): Promise<unknown> {
    return this.#text(message, options, false)
  }

  /** Masked input, for passwords and tokens. */
  async secure(message: string, options: PromptOptions = {}): Promise<unknown> {
    return this.#text(message, options, true)
  }

  async confirm(message: string, options?: BooleanPromptOptions): Promise<boolean>
  async confirm<R>(message: string, options: BooleanPromptOptions<R>): Promise<R>
  async confirm(message: string, options: BooleanPromptOptions<unknown> = {}): Promise<unknown> {
    return this.toggle(message, ['y', 'n'], options)
  }

  /** Two custom labels instead of yes/no (Console `toggle`). */
  async toggle(
    message: string,
    labels?: readonly [string, string],
    options?: BooleanPromptOptions,
  ): Promise<boolean>
  async toggle<R>(
    message: string,
    labels: readonly [string, string] | undefined,
    options: BooleanPromptOptions<R>,
  ): Promise<R>
  async toggle(
    message: string,
    labels: readonly [string, string] = ['y', 'n'],
    options: BooleanPromptOptions<unknown> = {},
  ): Promise<unknown> {
    const trapped = this.#takeTrap(message, options.name)
    if (trapped !== undefined) {
      const value = Boolean(trapped)
      await this.#assertTrapped(value, options)
      return options.result === undefined ? value : options.result(value)
    }

    const fallback = options.default ?? false
    const yes = labels[0]
    const no = labels[1]
    const shown = fallback ? `${yes.toUpperCase()}/${no}` : `${yes}/${no.toUpperCase()}`

    for (;;) {
      const answer = (
        await this.readLine(this.#label(message, options, `(${shown})`))
      ).toLowerCase()

      if (answer === '') {
        const problem = await this.#check(fallback, options)
        if (problem === undefined) {
          return options.result === undefined ? fallback : options.result(fallback)
        }
        stdout.write(`${colourise(problem, 'yellow')}\n`)
        continue
      }

      const affirmative = answer === yes.toLowerCase() || answer === 'yes' || answer === 'true'
      const negative = answer === no.toLowerCase() || answer === 'no' || answer === 'false'
      if (!affirmative && !negative) {
        stdout.write(`${colourise(`Answer ${yes} or ${no}.`, 'yellow')}\n`)
        continue
      }

      const problem = await this.#check(affirmative, options)
      if (problem !== undefined) {
        stdout.write(`${colourise(problem, 'yellow')}\n`)
        continue
      }
      return options.result === undefined ? affirmative : options.result(affirmative)
    }
  }

  /** Pick one option (Console `choice`). */
  async choice(
    message: string,
    choices: readonly PromptChoice[],
    options: SelectPromptOptions = {},
  ): Promise<unknown> {
    const picked = await this.#select(message, choices, options, false)
    return picked[0]
  }

  /** Pick several options (Console `multiple`). */
  async multiple(
    message: string,
    choices: readonly PromptChoice[],
    options: MultiplePromptOptions = {},
  ): Promise<unknown> {
    const picked = await this.#select(message, choices, options, true)
    return options.result ? options.result(picked.map(String)) : picked
  }

  /**
   * Pick one option by typing part of its name (Console `autocomplete`).
   *
   * Substring matching rather than fuzzy scoring — predictable, and enough for
   * the "too many options to list" case it exists for.
   */
  async autocomplete(
    message: string,
    choices: readonly PromptChoice[],
    options: SelectPromptOptions & { limit?: number } = {},
  ): Promise<unknown> {
    const trapped = this.#takeTrap(message, options.name)
    if (trapped !== undefined) {
      const picked = this.#fromTrap(trapped, choices, false)
      // Same rule as every other prompt: a scripted answer is held to the
      // command's own validation, or the test proves nothing.
      await this.#validateSelection(picked, options, false)
      return this.#applyResult(picked[0], options)
    }

    const limit = options.limit ?? 10
    for (;;) {
      const typed = await this.readLine(this.#label(message, options, '(type to filter)'))
      const matches = choices.filter((choice) =>
        nameOf(choice).toLowerCase().includes(typed.toLowerCase()),
      )

      if (matches.length === 0) {
        stdout.write(`${colourise('No match.', 'yellow')}\n`)
        continue
      }

      const first = matches[0]
      if (matches.length === 1 && first !== undefined) {
        return this.#finish(nameOf(first), options)
      }

      const picked = await this.#select(
        message,
        matches.slice(0, limit),
        { ...options, name: undefined },
        false,
      )
      return picked[0]
    }
  }

  // ─── internals ──────────────────────────────────────────────

  async #text(message: string, options: PromptOptions, masked: boolean): Promise<unknown> {
    const trapped = this.#takeTrap(message, options.name)
    if (trapped !== undefined) return this.#finish(String(trapped), options)

    for (;;) {
      const raw = await this.readLine(this.#label(message, options), masked)
      // `format` is display-only (Console): the returned value is what was typed,
      // with the default filled in when the line was empty.
      const value = raw === '' && options.default !== undefined ? options.default : raw

      const problem = await this.#check(value, options)
      if (problem !== undefined) {
        stdout.write(`${colourise(problem, 'yellow')}\n`)
        continue
      }
      return options.result ? options.result(value) : value
    }
  }

  async #select(
    message: string,
    choices: readonly PromptChoice[],
    options: SelectPromptOptions | MultiplePromptOptions,
    many: boolean,
  ): Promise<unknown[]> {
    if (choices.length === 0) {
      throw new ReamError('E_CONSOLE_EMPTY_CHOICES', `"${message}" was asked with no options.`)
    }

    const trapped = this.#takeTrap(message, options.name)
    if (trapped !== undefined) {
      const picked = this.#fromTrap(trapped, choices, many)
      // Same reasoning as the text prompts: a scripted answer the real prompt
      // would reject must fail the test, not sail through it.
      await this.#validateSelection(picked, options, many)
      return many ? picked : picked.map((value) => this.#applyResult(value, options))
    }

    const defaultLabel =
      options.default === undefined
        ? undefined
        : [options.default]
            .flat()
            .map((index) => {
              const choice = choices[index]
              return choice === undefined ? String(index) : displayOf(choice)
            })
            .join(', ')

    for (;;) {
      stdout.write(`${this.#label(message, { ...options, default: defaultLabel }).trimEnd()}\n`)
      choices.forEach((choice, index) => {
        const hint = typeof choice === 'string' ? undefined : choice.hint
        stdout.write(
          `  ${colourise(String(index + 1), 'cyan')}) ${displayOf(choice)}` +
            `${hint === undefined ? '' : colourise(` — ${hint}`, 'dim')}\n`,
        )
      })

      const answer = await this.readLine(
        many ? `Select (e.g. 1,3) from 1-${choices.length}: ` : `Select (1-${choices.length}): `,
      )

      // An empty answer takes the default — which for a selection prompt is an
      // index, as Adonis spells it. Without this the default was shown in the
      // label and then rejected as an invalid selection.
      const indexes =
        answer === '' && options.default !== undefined
          ? [options.default]
              .flat()
              .filter((index) => Number.isInteger(index) && index >= 0 && index < choices.length)
          : answer
              .split(',')
              .map((part) => Number(part.trim()) - 1)
              .filter((index) => Number.isInteger(index) && index >= 0 && index < choices.length)

      if (indexes.length === 0 || (!many && indexes.length !== 1)) {
        stdout.write(`${colourise('Invalid selection.', 'yellow')}\n`)
        continue
      }

      const picked = indexes.map((index) => nameOf(choices[index] as PromptChoice))
      const problem = await this.#selectionProblem(picked, options, many)
      if (problem !== undefined) {
        stdout.write(`${colourise(problem, 'yellow')}\n`)
        continue
      }
      return many ? picked : picked.map((value) => this.#applyResult(value, options))
    }
  }

  /** `result` for a single-value selection; `multiple` applies its own. */
  #applyResult(value: unknown, options: { result?: (value: never) => unknown }): unknown {
    return options.result === undefined
      ? value
      : Reflect.apply(options.result, undefined, [String(value)])
  }

  /**
   * Validation subject for a selection: the whole array for `multiple`, the
   * single value otherwise — so an Console rule written `validate(values: string[])`
   * behaves the same here.
   */
  async #selectionProblem(
    picked: readonly unknown[],
    options: { validate?: (value: never) => boolean | string | Promise<boolean | string> },
    many: boolean,
  ): Promise<string | undefined> {
    if (options.validate === undefined) return undefined
    const subject = many ? picked.map(String) : String(picked[0] ?? '')
    const verdict = await Reflect.apply(options.validate, undefined, [subject])
    if (verdict === true) return undefined
    return typeof verdict === 'string' ? verdict : 'Invalid value.'
  }

  async #validateSelection(
    picked: readonly unknown[],
    options: { validate?: (value: never) => boolean | string | Promise<boolean | string> },
    many: boolean,
  ): Promise<void> {
    const problem = await this.#selectionProblem(picked, options, many)
    if (problem === undefined) return
    throw new ReamError(
      'E_CONSOLE_INVALID_TRAP_VALUE',
      `A scripted answer was rejected by its own validation: ${problem}`,
      { hint: 'The trap supplies a value the real prompt would refuse — fix the test.' },
    )
  }

  /**
   * Apply `format`, `validate` and `result` to a value that came from a trap.
   *
   * Skipping `validate` here would let a test inject a value the real prompt
   * would have rejected, and the command would pass — a test giving confidence
   * in something that cannot happen. A trapped value that fails validation is a
   * broken test, so it throws instead of re-asking: there is nobody to re-ask.
   */
  async #finish(
    value: string,
    options: Pick<PromptOptions, 'validate' | 'result'>,
  ): Promise<unknown> {
    await this.#assertTrapped(value, options)
    return options.result ? options.result(value) : value
  }

  // Only the validation hook, so `SelectPromptOptions` (whose `default` is an
  // index, not a value) passes without a variance conflict.
  async #assertTrapped<T>(value: T, options: ValidatableOptions<T>): Promise<void> {
    const problem = await this.#check(value, options)
    if (problem === undefined) return
    throw new ReamError(
      'E_CONSOLE_INVALID_TRAP_VALUE',
      `A scripted answer was rejected by its own validation: ${problem}`,
      { hint: 'The trap supplies a value the real prompt would refuse — fix the test.' },
    )
  }

  #fromTrap(trapped: unknown, choices: readonly PromptChoice[], many: boolean): unknown[] {
    const read = (index: number): string => {
      const choice = choices[index]
      if (choice === undefined) {
        throw new ReamError(
          'E_CONSOLE_TRAP_OUT_OF_RANGE',
          `A trap chose option ${index + 1}, but only ${choices.length} were offered.`,
        )
      }
      return nameOf(choice)
    }

    if (typeof trapped === 'object' && trapped !== null) {
      const indexes = Reflect.get(trapped, 'indexes')
      if (Array.isArray(indexes)) return indexes.map((index) => read(Number(index)))
      const index = Reflect.get(trapped, 'index')
      if (typeof index === 'number') return [read(index)]
    }
    // A trap that replied with a raw value: honour it as-is.
    if (many) return Array.isArray(trapped) ? trapped : [trapped]
    return [trapped]
  }

  /** Consume a scripted answer, if one was installed for this prompt. */
  #takeTrap(message: string, name: string | undefined): unknown {
    const key = name ?? message
    if (!this.#traps.has(key)) return undefined
    const value = this.#traps.get(key)
    this.#traps.delete(key)
    return value
  }

  async #check<T>(value: T, options: ValidatableOptions<T>): Promise<string | undefined> {
    if (options.validate === undefined) return undefined
    const verdict = await options.validate(value)
    if (verdict === true) return undefined
    return typeof verdict === 'string' ? verdict : 'Invalid value.'
  }

  // Only the display fields, so a `PromptOptions<boolean>` can be passed
  // without tripping over the contravariance of `validate`.
  #label(
    message: string,
    options: { hint?: string; default?: unknown; format?: (value: never) => unknown },
    suffix?: string,
  ): string {
    const hint = options.hint === undefined ? '' : colourise(` (${options.hint})`, 'dim')
    // The one place `format` legitimately applies: what is shown, not what is
    // returned.
    const shownDefault =
      options.default !== undefined && options.format !== undefined
        ? Reflect.apply(options.format, undefined, [options.default])
        : options.default
    const shown = shownDefault === undefined ? '' : ` [${String(shownDefault)}]`
    const tail = suffix === undefined ? '' : ` ${suffix}`
    return `${message}${hint}${shown}${tail}: `
  }

  /**
   * Read one line from the terminal.
   *
   * `protected` on purpose: it is the single seam through which input enters,
   * so a test (or a future non-readline frontend) can substitute it by
   * subclassing instead of faking a TTY.
   */
  protected readLine(query: string, masked = false): Promise<string> {
    if (!stdin.isTTY) {
      return Promise.reject(
        new ReamError(
          'E_CONSOLE_NOT_INTERACTIVE',
          `Cannot prompt for "${query.trim()}" — stdin is not interactive.`,
          {
            hint: 'Pass the value as a flag, or script the answer in tests with prompt.trap(name).',
          },
        ),
      )
    }

    const rl = createInterface({ input: stdin, output: stdout, terminal: true })

    // readline echoes each keystroke through _writeToOutput; replacing it is
    // the dependency-free way to hide what is typed.
    if (masked && isEchoing(rl)) {
      rl._writeToOutput = (text: string): void => {
        stdout.write(text.includes(query) ? query : '')
      }
    }

    return new Promise((resolve) => {
      rl.question(query, (answer) => {
        if (masked) stdout.write('\n')
        rl.close()
        resolve(answer.trim())
      })
    })
  }
}

/** readline's undocumented echo hook, present on a terminal interface. */
interface EchoingInterface {
  _writeToOutput(text: string): void
}

function isEchoing(value: object): value is EchoingInterface {
  return '_writeToOutput' in value && typeof Reflect.get(value, '_writeToOutput') === 'function'
}

function nameOf(choice: PromptChoice): string {
  return typeof choice === 'string' ? choice : choice.name
}

function displayOf(choice: PromptChoice): string {
  return typeof choice === 'string' ? choice : (choice.message ?? choice.name)
}
