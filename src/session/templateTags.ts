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
