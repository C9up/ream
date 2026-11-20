/**
 * The application REPL — AdonisJS's `Repl`, in shape and in method names.
 *
 *   import repl from '@c9up/ream/services/repl'
 *   repl.addMethod('loadModels', async () => { … }, {
 *     description: 'Load every entity onto the prompt',
 *   })
 *   repl.start({ app, router })
 *
 * Built on `node:repl`, which is the REPL — this adds what makes it an
 * APPLICATION repl: a context seeded with the booted services, helpers a
 * project registers itself, and `.ls` to list them, because a prompt full of
 * undiscoverable helpers is a prompt nobody uses.
 */

import type { REPLEval, REPLServer, ReplOptions } from 'node:repl'
import { Recoverable, start as startNodeRepl } from 'node:repl'

/** What a registered helper receives — the repl itself, then its arguments. */
export type MethodCallback = (repl: Repl, ...args: unknown[]) => unknown

/** How a helper describes itself in `.ls`. */
export interface MethodOptions {
  description?: string
  usage?: string
}

/**
 * A TypeScript compiler for the prompt, when the host has one.
 *
 * `node:repl` evaluates JavaScript. A project whose code is TypeScript wants
 * to paste TypeScript, so the host supplies the compiler it already runs
 * rather than ream carrying one.
 */
export interface Compiler {
  compile(code: string, fileName: string): string
  supportsTypescript: boolean
}

/**
 * How the repl is built — AdonisJS's `ReplOptions`: `node:repl`'s own options
 * (`input`, `output`, `terminal`, `writer`…) pass straight through.
 */
export interface ReplConstructorOptions extends Omit<ReplOptions, 'eval'> {
  /** Where `notify()` writes. Defaults to stdout. */
  write?: (message: string) => void
  /** Compile code typed at the prompt; the same as calling {@link Repl.useCompiler}. */
  compiler?: Compiler
  /** Persist the prompt's history to this file across sessions. */
  historyFilePath?: string
}

/**
 * The parse errors that mean "the statement is not finished yet", so the
 * prompt keeps reading lines instead of reporting it — upstream's test.
 */
function isRecoverableError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /^(Unexpected end of input|Unexpected token|' expected)/.test(error.message)
  )
}

interface RegisteredMethod {
  handler: MethodCallback
  options: MethodOptions & { width: number }
}

export class Repl {
  readonly #methods = new Map<string, RegisteredMethod>()
  readonly #readyCallbacks: Array<(repl: Repl) => void> = []
  #compiler: Compiler | undefined
  #server: REPLServer | undefined
  readonly #historyFilePath: string | undefined
  readonly #replOptions: Omit<ReplOptions, 'eval'>
  readonly #write: (message: string) => void

  constructor(options: ReplConstructorOptions = {}) {
    const { write, compiler, historyFilePath, ...replOptions } = options
    this.#compiler = compiler
    this.#historyFilePath = historyFilePath
    this.#replOptions = replOptions
    this.#write =
      write ??
      ((message) => {
        process.stdout.write(message)
      })
  }

  /**
   * Print a message around the prompt.
   *
   * Newline-wrapped: written mid-session the text would otherwise land on the
   * line the user is typing.
   */
  notify(message: string): void {
    this.#write(`\n${message}\n`)
  }

  /** Run `callback` once the prompt is up. Chainable. */
  ready(callback: (repl: Repl) => void): this {
    this.#readyCallbacks.push(callback)
    return this
  }

  /**
   * Register a helper, available at the prompt by name. Chainable.
   *
   * `width` is the name's display width, recorded here so `.ls` can align a
   * column without measuring the set twice.
   */
  addMethod(name: string, handler: MethodCallback, options: MethodOptions = {}): this {
    this.#methods.set(name, { handler, options: { ...options, width: name.length } })
    return this
  }

  /** Every registered helper, keyed by name — AdonisJS `getMethods`. */
  getMethods(): Record<string, RegisteredMethod> {
    return Object.fromEntries(this.#methods)
  }

  /** Use `compiler` for the code typed at the prompt. Chainable. */
  useCompiler(compiler: Compiler): this {
    this.#compiler = compiler
    return this
  }

  /** The compiler in use, if any. */
  get compiler(): Compiler | undefined {
    return this.#compiler
  }

  /** The underlying `node:repl` server, once started. */
  get server(): REPLServer | undefined {
    return this.#server
  }

  /**
   * List the registered helpers, one per line, names aligned.
   *
   * Exposed rather than private because it IS the `.ls` command, and a caller
   * driving the repl programmatically (a test, a custom command) needs the
   * same listing without a live prompt.
   */
  describeMethods(): string {
    if (this.#methods.size === 0) return 'No methods registered'
    const widest = Math.max(...[...this.#methods.values()].map((m) => m.options.width))
    return [...this.#methods]
      .map(([name, method]) => {
        const description = method.options.description ?? ''
        const usage = method.options.usage ? ` (${method.options.usage})` : ''
        return `${name.padEnd(widest)}  ${description}${usage}`.trimEnd()
      })
      .join('\n')
  }

  /**
   * Start the prompt, seeding it with `context`.
   *
   * Registered helpers are bound to this repl before the prompt appears — a
   * helper that only exists after the first keystroke is a helper the user
   * finds missing.
   */
  start(context: Record<string, unknown> = {}): this {
    const server = startNodeRepl({ prompt: '> ', useGlobal: false, ...this.#replOptions })
    this.#server = server
    this.#setupHistory(server)
    // Typed code goes through the compiler, then through node's own evaluator.
    // `node:repl` reads `this.eval` per line; the typings mark it read-only, so
    // it is redefined rather than assigned (upstream assigns it).
    Object.defineProperty(server, 'eval', {
      value: this.#compilingEval(server, server.eval),
      configurable: true,
      writable: true,
    })

    for (const [key, value] of Object.entries(context)) {
      Object.defineProperty(server.context, key, { value, configurable: true, enumerable: true })
    }
    for (const [name, method] of this.#methods) {
      Object.defineProperty(server.context, name, {
        value: (...args: unknown[]) => method.handler(this, ...args),
        configurable: true,
        enumerable: true,
      })
    }

    server.defineCommand('ls', {
      help: 'List the helpers available at this prompt',
      action: () => {
        this.notify(this.describeMethods())
        server.displayPrompt()
      },
    })

    for (const callback of this.#readyCallbacks) callback(this)
    return this
  }

  /**
   * Wrap `node:repl`'s evaluator so the compiler sees the code first. The
   * compiler is read at each line, so `useCompiler()` after `start()` applies.
   * A compile error that only means "statement not finished" is handed back
   * as `Recoverable`, which keeps multi-line input working.
   */
  #compilingEval(server: REPLServer, evaluate: REPLEval): REPLEval {
    return (code, context, fileName, callback) => {
      let compiled: string
      try {
        compiled = this.#compiler ? this.#compiler.compile(code, fileName) : code
      } catch (error) {
        if (isRecoverableError(error)) {
          callback(new Recoverable(error instanceof Error ? error : new Error(String(error))), null)
          return
        }
        callback(error instanceof Error ? error : new Error(String(error)), null)
        return
      }
      // The original evaluator expects the server as `this`.
      evaluate.call(server, compiled, context, fileName, callback)
    }
  }

  /**
   * Persist the history to `historyFilePath`, when one was given.
   *
   * DEVIATION (named): upstream exits the process when the history file cannot
   * be written. Here the session goes on without history and says why — a
   * read-only home directory is no reason to refuse a prompt.
   */
  #setupHistory(server: REPLServer): void {
    if (!this.#historyFilePath) return
    const path = this.#historyFilePath
    server.setupHistory(path, (error) => {
      if (error) this.notify(`Unable to use the history file ${path}: ${error.message}`)
    })
  }
}
