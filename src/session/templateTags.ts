import { ReamError } from '../errors/ReamError.js'

/**
 * The flash-message tags AdonisJS's session publishes to templates.
 *
 * A migrated template keeps writing:
 *
 *   @error('email')<p>{{ $message }}</p>@enderror
 *   @errors<ul>@each(m in $messages)<li>{{ m }}</li>@endeach</ul>@enderrors
 *   @inputError('email')@each(m in $messages)<i>{{ m }}</i>@endeach@endinputError
 *   @flashMessage('notice')<p>{{ $message }}</p>@endflashMessage
 *
 * Each renders its body only when the message exists, and binds it under the
 * name upstream uses (`$message` / `$messages`) — bound into the BODY's scope,
 * so it does not leak past the tag.
 *
 * The values come from the `flashMessages` store the session middleware shares
 * into `ctx.view`; the tag reads it out of the render scope.
 */

/** The single surface these tags need of a template engine. */
export interface TemplateTagEngine {
  registerTag(tag: {
    tagName: string
    block: boolean
    seekable: boolean
    compile(
      parser: unknown,
      buffer: { writeRaw(text: string): void },
      token: {
        properties: { jsArg: string }
        renderBody(locals?: Readonly<Record<string, unknown>>): string | Promise<string>
        evaluate(expression: string): unknown
      },
    ): void | Promise<void>
  }): void
}

/** The bag shape the session shares — matches `ReadOnlyValuesStore`. */
interface FlashStore {
  get(path: string | readonly string[], defaultValue?: unknown): unknown
  has(path: string | readonly string[]): boolean
}

function isFlashStore(value: unknown): value is FlashStore {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'get') === 'function' &&
    typeof Reflect.get(value, 'has') === 'function'
  )
}

/**
 * Register `@error`, `@errors`, `@inputError` and `@flashMessage` on `engine`.
 *
 * Safe to call when no session ran: a template rendered outside a request finds
 * no store in scope and every tag renders nothing, rather than throwing.
 */
export function registerSessionTemplateTags(engine: TemplateTagEngine): void {
  /** The shared store, or undefined outside a request. */
  const storeOf = (evaluate: (expr: string) => unknown): FlashStore | undefined => {
    const value = evaluate("typeof flashMessages === 'undefined' ? undefined : flashMessages")
    return isFlashStore(value) ? value : undefined
  }

  engine.registerTag({
    tagName: 'flashMessage',
    block: true,
    seekable: true,
    async compile(_parser, buffer, token) {
      const store = storeOf(token.evaluate)
      if (store === undefined) return
      const key = token.evaluate(token.properties.jsArg)
      if (typeof key !== 'string' || !store.has(key)) return
      buffer.writeRaw(await token.renderBody({ $message: store.get(key) }))
    },
  })

  engine.registerTag({
    tagName: 'error',
    block: true,
    seekable: true,
    async compile(_parser, buffer, token) {
      const store = storeOf(token.evaluate)
      if (store === undefined) return
      const field = token.evaluate(token.properties.jsArg)
      if (typeof field !== 'string') return
      const path = ['errorsBag', field]
      if (!store.has(path)) return
      buffer.writeRaw(await token.renderBody({ $message: store.get(path) }))
    },
  })

  engine.registerTag({
    tagName: 'errors',
    block: true,
    // `@errors` takes no argument, exactly as upstream declares it.
    seekable: false,
    async compile(_parser, buffer, token) {
      const store = storeOf(token.evaluate)
      if (store === undefined || !store.has('errorsBag')) return
      buffer.writeRaw(await token.renderBody({ $messages: store.get('errorsBag') }))
    },
  })

  engine.registerTag({
    tagName: 'inputError',
    block: true,
    seekable: true,
    async compile(_parser, buffer, token) {
      const store = storeOf(token.evaluate)
      if (store === undefined) return
      const field = token.evaluate(token.properties.jsArg)
      if (typeof field !== 'string') return
      const bag = store.get('inputErrorsBag', {})
      const messages =
        typeof bag === 'object' && bag !== null && Object.hasOwn(bag, field)
          ? Reflect.get(bag, field)
          : undefined
      // Upstream gates on truthiness, so an empty list renders nothing.
      if (!messages) return
      buffer.writeRaw(await token.renderBody({ $messages: messages }))
    },
  })
}

/** Loads the template engine package. Swappable so a test needs no engine. */
export type EnginePackageLoader = () => Promise<unknown>

const loadInker: EnginePackageLoader = () => {
  // Built rather than written inline: inker is an OPTIONAL peer, and a literal
  // `import('@c9up/inker')` makes a bundler resolve it at build time for an
  // application that never installed it. Computed, it only runs behind the
  // `usingInker` flag.
  const specifier = '@c9up/inker'
  return import(/* @vite-ignore */ specifier)
}

function unusable(detail: string): ReamError {
  return new ReamError(
    'E_SESSION_TEMPLATE_ENGINE_UNUSABLE',
    `The template engine is installed but the session tags cannot be registered: ${detail}`,
    {
      hint: '`@c9up/inker` must default-export its plugin registrar (`inker.use(plugin)`), whose plugins receive an engine with `registerTag()`.',
    },
  )
}

/**
 * Publish the session tags into the template engine, the way AdonisJS's
 * session does with Edge: through the engine package's MODULE SINGLETON
 * (`inker.use(plugin)`), guarded by the host's `usingInker` flag — never by
 * resolving a container binding. `use()` queues the plugin, and the engine
 * runs it before its next render, whenever the engine was built.
 *
 * Returns whether the tags were handed over. A registrar or an engine of the
 * wrong shape is an error, not a skip: a template using `@flashMessage`
 * would otherwise render it as plain text with no warning.
 */
export async function installSessionTemplateTags(
  usingInker: boolean,
  load: EnginePackageLoader = loadInker,
): Promise<boolean> {
  if (!usingInker) return false
  const module: unknown = await load()
  const registrar =
    typeof module === 'object' && module !== null ? Reflect.get(module, 'default') : undefined
  const use = Reflect.get(Object(registrar), 'use')
  if (typeof use !== 'function') throw unusable('its default export has no use()')
  use.call(registrar, (engine: unknown) => {
    const register = Reflect.get(Object(engine), 'registerTag')
    if (typeof register !== 'function') throw unusable('the engine has no registerTag()')
    registerSessionTemplateTags({
      registerTag: (tag) => {
        register.call(engine, tag)
      },
    })
  })
  return true
}
