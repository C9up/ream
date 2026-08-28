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

import type { REPLServer } from 'node:repl'
import { start as startNodeRepl } from 'node:repl'

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

interface RegisteredMethod {
  handler: MethodCallback
  options: MethodOptions & { width: number }
}

export class Repl {
  readonly #methods = new Map<string, RegisteredMethod>()
  readonly #readyCallbacks: Array<(repl: Repl) => void> = []
  #compiler: Compiler | undefined
  #server: REPLServer | undefined
  readonly #prompt: string
  readonly #write: (message: string) => void

  constructor(options: { prompt?: string; write?: (message: string) => void } = {}) {
    this.#prompt = options.prompt ?? '> '
    this.#write =
      options.write ??
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
    const server = startNodeRepl({ prompt: this.#prompt, useGlobal: false })
    this.#server = server

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
}
