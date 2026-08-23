/**
 * `@error` / `@errors` / `@inputError` / `@flashMessage` — the flash tags
 * AdonisJS's session publishes. Every form in a migrated app uses them.
 *
 * ream must not depend on the template engine, so the tags are exercised
 * against a stub that implements the same `registerTag` contract: the same
 * decision (render or not) and the same bound name (`$message` / `$messages`).
 */
import { describe, expect, it } from 'vitest'
import { ReadOnlyValuesStore } from '../../src/session/ReadOnlyValuesStore.js'
import {
  registerSessionTemplateTags,
  type TemplateTagEngine,
} from '../../src/session/templateTags.js'

interface Rendered {
  rendered: boolean
  locals?: Readonly<Record<string, unknown>>
}

/** Collect the tags, then run one against a scope and report what it did. */
function harness(scope: Record<string, unknown>) {
  const tags = new Map<string, Parameters<TemplateTagEngine['registerTag']>[0]>()
  registerSessionTemplateTags({
    registerTag: (tag) => {
      tags.set(tag.tagName, tag)
    },
  })
  return async (tagName: string, jsArg: string): Promise<Rendered> => {
    const tag = tags.get(tagName)
    if (!tag) throw new Error(`${tagName} was never registered`)
    const result: Rendered = { rendered: false }
    await tag.compile(
      undefined,
      { writeRaw: () => {} },
      {
        properties: { jsArg },
        renderBody: (locals) => {
          result.rendered = true
          result.locals = locals
          return ''
        },
        // The stub evaluates against `scope` the way the engine would.
        evaluate: (expression) => {
          if (expression.includes('flashMessages')) return scope.flashMessages
          return JSON.parse(expression.replace(/'/g, '"'))
        },
      },
    )
    return result
  }
}

const withFlash = (values: Record<string, unknown>) =>
  harness({ flashMessages: new ReadOnlyValuesStore(values) })

describe('ream > session template tags', () => {
  it('registers the four tags AdonisJS publishes', () => {
    const seen: string[] = []
    registerSessionTemplateTags({
      registerTag: (tag) => {
        seen.push(tag.tagName)
      },
    })
    expect(seen.sort()).toEqual(['error', 'errors', 'flashMessage', 'inputError'])
  })

  it('@errors takes no argument, the other three do', () => {
    const seen = new Map<string, boolean>()
    registerSessionTemplateTags({
      registerTag: (tag) => {
        seen.set(tag.tagName, tag.seekable)
      },
    })
    expect(seen.get('errors')).toBe(false)
    expect(seen.get('error')).toBe(true)
    expect(seen.get('flashMessage')).toBe(true)
    expect(seen.get('inputError')).toBe(true)
  })

  it('@flashMessage renders and binds $message', async () => {
    const run = withFlash({ notice: 'Saved' })
    expect(await run('flashMessage', "'notice'")).toEqual({
      rendered: true,
      locals: { $message: 'Saved' },
    })
  })

  it('@flashMessage skips an absent key', async () => {
    const run = withFlash({})
    expect((await run('flashMessage', "'notice'")).rendered).toBe(false)
  })

  it('@error reads the errorsBag by path', async () => {
    const run = withFlash({ errorsBag: { email: 'Required' } })
    expect(await run('error', "'email'")).toEqual({
      rendered: true,
      locals: { $message: 'Required' },
    })
    expect((await run('error', "'name'")).rendered).toBe(false)
  })

  it('@errors binds the whole bag as $messages', async () => {
    const run = withFlash({ errorsBag: ['a', 'b'] })
    expect(await run('errors', '')).toEqual({
      rendered: true,
      locals: { $messages: ['a', 'b'] },
    })
  })

  it('@inputError binds the field messages, and skips an empty bag', async () => {
    const run = withFlash({ inputErrorsBag: { email: ['too short'] } })
    expect(await run('inputError', "'email'")).toEqual({
      rendered: true,
      locals: { $messages: ['too short'] },
    })
    expect((await run('inputError', "'name'")).rendered).toBe(false)
  })

  it('renders nothing outside a request, when no store was shared', async () => {
    const run = harness({})
    expect((await run('error', "'email'")).rendered).toBe(false)
    expect((await run('errors', '')).rendered).toBe(false)
    expect((await run('flashMessage', "'x'")).rendered).toBe(false)
    expect((await run('inputError', "'email'")).rendered).toBe(false)
  })
})
