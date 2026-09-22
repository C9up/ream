/**
 * What the browser watches to know the server changed under it.
 *
 * Two things can happen while `ream dev` runs, and the page has no way to see
 * either: a module is swapped in the running process (hot-hook invalidated it),
 * or the process restarts. Both change what the server would render, and both
 * used to leave a stale page on screen until someone pressed reload.
 *
 * NAMED DEVIATION — upstream has no equivalent. AdonisJS' assembler does not
 * refresh the browser; that comes from its Vite integration, i.e. from the
 * asset pipeline. Ream has no such pipeline in the general case, so this lives
 * in the framework, and it is deliberately the smallest thing that works: a
 * token the page polls, not a socket. A socket would still need a reconnect
 * loop and a boot identity to survive the restart half, which is most of a
 * poller with more moving parts.
 */

/** Where the token is served, and what the injected script polls. */
export const HMR_PATH = '/__ream/hmr'

/**
 * Identifies THIS process. A restart produces a new one, which is how the page
 * detects a reboot without the server having to survive it to say so.
 */
const BOOT_ID = `${process.pid}-${Date.now().toString(36)}`

/** Bumped by `@c9up/ream/hot` every time hot-hook swaps a module. */
const COUNTER = Symbol.for('ream.dev.hotReloadCount')

interface CounterHolder {
  [COUNTER]?: number
}

/**
 * A module-level variable would not do: `@c9up/ream/hot` is loaded through a
 * different module graph than the running application (it is an `--import`
 * entry), so the two would each hold their own copy. A well-known symbol on
 * `globalThis` is the one place both can see.
 */
function holder(): CounterHolder {
  return globalThis as unknown as CounterHolder
}

/** Called by the hot entry when hot-hook reports a module was swapped. */
export function hotReloadHappened(): void {
  const store = holder()
  store[COUNTER] = (store[COUNTER] ?? 0) + 1
  notifyClients()
}

/**
 * The dev clients currently listening.
 *
 * A `Set` and not a count: each entry is pushed to on a swap, and dropped when
 * the tab closes. `unknown`-typed on purpose — this module must not import the
 * HTTP layer, which imports it back.
 */
interface DevClient {
  send: (event: string, data: unknown) => Promise<boolean>
  onClose: (callback: () => void) => void
}

const clients = new Set<DevClient>()

/** The event name the injected script listens for. */
const HMR_EVENT = 'ream:hmr'

/**
 * Answer the dev client BEFORE any application middleware runs, and PUSH.
 *
 * Two problems, one change.
 *
 * It used to be an ordinary route polled once a second, per open tab, and a
 * route runs the whole middleware stack. An application that resolves a user
 * from a session cookie therefore ran `SELECT * FROM users` once a second for
 * a response whose entire content is a process id and a counter, and which
 * depends on no user, no session and no body.
 *
 * It is a stream now, so the cost is paid ONCE per tab instead of once a
 * second, and a change reaches the browser immediately rather than up to a
 * second later. Upstream gets the same thing from Vite's websocket; this needs
 * no bundler, because the server already speaks SSE.
 *
 * Registered FIRST rather than merely outside the router: middleware that
 * authenticates lives at either tier, and an application is free to put it in
 * `server.use([...])` — many do, because it must run before routing.
 *
 * Development only. In production nothing injects the script and nothing
 * registers this.
 */
export function hmrEndpoint(): (
  ctx: {
    request: { url: () => string }
    response: { sse: () => Promise<DevClient> }
  },
  next: () => Promise<void>,
) => Promise<void> {
  return async (ctx, next) => {
    // `url()` carries the query string; a client may append a cache-buster.
    const path = ctx.request.url().split('?')[0]
    if (path !== HMR_PATH) {
      await next()
      return
    }

    let stream: DevClient
    try {
      stream = await ctx.response.sse()
    } catch {
      // A host without the streaming NAPI — a mock server in a test, say.
      // Losing the reload is fine; failing the request is not.
      await next()
      return
    }

    clients.add(stream)
    stream.onClose(() => clients.delete(stream))
    // Immediately, so a tab that connects after a restart compares against the
    // CURRENT token rather than waiting for the next swap to learn anything.
    await stream.send(HMR_EVENT, hmrToken())
  }
}

/** Tell every open tab the token moved. */
function notifyClients(): void {
  const token = hmrToken()
  for (const client of clients) {
    // Detached: a swap must not wait on a socket, and a dead one is dropped by
    // its own close handler.
    void client.send(HMR_EVENT, token).catch(() => clients.delete(client))
  }
}

/** How many hot swaps this process has seen. */
export function hotReloadCount(): number {
  return holder()[COUNTER] ?? 0
}

/**
 * The token. Changes on a restart (new boot id) and on a hot swap (new count),
 * which are exactly the two cases the page must react to.
 */
export function hmrToken(): string {
  return `${BOOT_ID}.${hotReloadCount()}`
}

/**
 * The script injected into HTML pages in dev.
 *
 * An `EventSource`, not a poll. The server pushes the token, so a change
 * reaches the page immediately and an idle tab costs one open connection
 * rather than a request per second through the whole middleware stack.
 *
 * It reloads when the token CHANGES, never when the connection fails: a
 * restarting server is unreachable for a moment, and reloading then would only
 * show the browser's error page. `EventSource` reconnects on its own, and the
 * server greets the new connection with its token — which after a restart is a
 * different boot id, so the reload happens then, once the server can serve it.
 */
export function hmrClientScript(nonce?: string): string {
  // A nonce-based CSP — which the scaffold ships, via `@c9up/blackhole` —
  // rejects an inline script that does not carry the request's nonce, and the
  // page simply never reloads. `response.nonce` is where it lives; the quotes
  // are escaped because a nonce is generated, not user input, but a broken
  // attribute would silently disable the tag rather than fail loudly.
  const attribute = nonce === undefined ? '' : ` nonce="${nonce.replace(/"/g, '&quot;')}"`
  // `addEventListener(HMR_EVENT)`, NOT `onmessage`: the stream names its
  // events, and `onmessage` fires only for unnamed ones — a client wired that
  // way receives nothing at all, silently, which is a mistake this codebase
  // has already made once with relay.
  return `<script${attribute}>(()=>{let t=null;const s=new EventSource(${JSON.stringify(
    HMR_PATH,
  )});s.addEventListener(${JSON.stringify(
    HMR_EVENT,
  )},e=>{let n;try{n=JSON.parse(e.data)}catch(_){n=e.data}if(t===null){t=n}else if(n!==t){s.close();location.reload()}})})()</script>`
}
