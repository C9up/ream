/**
 * The browser has no way to see the server change under it.
 *
 * A hot swap replaces a module in the running process and a restart replaces
 * the process; both change what the server would render, and neither used to
 * reach the page. The token is what the injected script watches, so its two
 * failure modes are "never changes" (nothing ever reloads) and "always
 * changes" (the page reloads in a loop).
 */
import { describe, expect, it } from 'vitest'
import {
  HMR_PATH,
  hmrClientScript,
  hmrToken,
  hotReloadCount,
  hotReloadHappened,
} from '../../src/dev/hmr.js'
import type { HttpContext } from '../../src/http/HttpContext.js'
import { createHttpKernel, MiddlewareRegistry, Router } from '../../src/index.js'

type HttpResponseLike = HttpContext['response']

describe('dev > the reload token', () => {
  it('is stable while nothing happens', () => {
    // A token that changed on its own would reload the page every second.
    expect(hmrToken()).toBe(hmrToken())
  })

  it('changes when a module is hot-swapped', () => {
    const before = hmrToken()
    hotReloadHappened()

    expect(hmrToken()).not.toBe(before)
  })

  it('counts every swap, so two in a row are two changes', () => {
    const start = hotReloadCount()
    hotReloadHappened()
    const middle = hmrToken()
    hotReloadHappened()

    expect(hotReloadCount()).toBe(start + 2)
    expect(hmrToken()).not.toBe(middle)
  })

  it('carries the process identity, so a restart is a change', () => {
    // The restarted process cannot be told about the old one: the token has to
    // differ by construction, which is what the pid + boot time give it.
    expect(hmrToken()).toContain(String(process.pid))
  })
})

describe('dev > the injected script', () => {
  const script = hmrClientScript()

  it('polls the path the server answers on', () => {
    expect(script).toContain(JSON.stringify(HMR_PATH))
  })

  it('reloads the page, and asks for no cached answer', () => {
    expect(script).toContain('location.reload()')
    expect(script).toContain("cache:'no-store'")
  })

  it('does not reload on a failed request', () => {
    // A restarting server is unreachable for a moment. Reloading then shows the
    // browser's error page instead of the application.
    const failurePath = script.slice(script.indexOf('catch'))
    expect(failurePath).not.toContain('location.reload()')
  })

  it('is one self-contained tag, so it can be appended anywhere', () => {
    expect(script.startsWith('<script>')).toBe(true)
    expect(script.endsWith('</script>')).toBe(true)
    // A stray `</script>` inside would close the tag early and dump the rest of
    // the code as text into the page.
    expect(script.slice(8, -9)).not.toContain('</script>')
  })
})

describe('dev > injecting the script into a response', () => {
  const SCRIPT = '<script>RELOAD</script>'

  function get(path: string) {
    return { method: 'GET', path, query: '', headers: {}, body: '' }
  }

  async function respond(
    handler: (ctx: { response: HttpResponseLike }) => void,
    devReloadScript?: string,
  ) {
    const router = new Router()
    router.get('/page', handler)
    const kernel = createHttpKernel({
      router,
      middleware: new MiddlewareRegistry(),
      devReloadScript: devReloadScript === undefined ? undefined : () => devReloadScript,
    })
    return kernel(get('/page'))
  }

  it('lands inside the document, not after it', async () => {
    // Appended after `</body>` the tag is still parsed, but the page it is
    // meant to be part of has already closed — and anything reading the
    // document's tail sees framework code where the app's markup ended.
    const res = await respond(({ response }) => {
      response.send('<html><body><h1>hi</h1></body></html>')
    }, SCRIPT)

    expect(res.body).toBe(`<html><body><h1>hi</h1>${SCRIPT}</body></html>`)
  })

  it('still injects into a fragment with no </body>', async () => {
    const res = await respond(({ response }) => {
      response.send('<div>fragment</div>')
    }, SCRIPT)

    expect(res.body).toBe(`<div>fragment</div>${SCRIPT}`)
  })

  it('leaves JSON alone', async () => {
    // A script appended to a JSON body is not a cosmetic problem: it is a
    // parse error at every client of the API.
    const res = await respond(({ response }) => {
      response.json({ ok: true })
    }, SCRIPT)

    expect(res.body).toBe('{"ok":true}')
  })

  it('leaves plain text alone', async () => {
    const res = await respond(({ response }) => {
      response.send('not html')
    }, SCRIPT)

    expect(res.body).toBe('not html')
  })

  it('touches nothing when no script is configured', async () => {
    // Production: the response is byte-for-byte what the handler produced.
    const res = await respond(({ response }) => {
      response.send('<html><body>hi</body></html>')
    })

    expect(res.body).toBe('<html><body>hi</body></html>')
  })
})

describe('dev > the script under a nonce-based CSP', () => {
  it('carries the nonce it was given', () => {
    // The scaffold ships blackhole with `script-src 'self' 'nonce-…'`. Without
    // the nonce the browser refuses to run the tag and the page simply never
    // reloads — with nothing wrong anywhere except one console line.
    expect(hmrClientScript('abc123')).toContain('<script nonce="abc123">')
  })

  it('has no nonce attribute when there is none', () => {
    expect(hmrClientScript()).toContain('<script>')
  })

  it('cannot have its attribute closed early', () => {
    const script = hmrClientScript('a"b')
    expect(script).toContain('nonce="a&quot;b"')
    expect(script.startsWith('<script nonce="a&quot;b">')).toBe(true)
  })
})
