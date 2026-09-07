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
 * It reloads when the token changes, NOT when the request fails: a server that
 * is restarting is unreachable for a moment, and reloading then would only show
 * the browser's error page. It waits for an answer, and the answer carries a
 * new boot id.
 */
export function hmrClientScript(nonce?: string): string {
  // A nonce-based CSP — which the scaffold ships, via `@c9up/blackhole` —
  // rejects an inline script that does not carry the request's nonce, and the
  // page simply never reloads. `response.nonce` is where it lives; the quotes
  // are escaped because a nonce is generated, not user input, but a broken
  // attribute would silently disable the tag rather than fail loudly.
  const attribute = nonce === undefined ? '' : ` nonce="${nonce.replace(/"/g, '&quot;')}"`
  // A failed poll RETRIES. Returning on `!r.ok` stopped the loop for good, so a
  // page opened in the window before the endpoint is mounted — or during any
  // blip — never reloaded again for the life of that tab, which looks exactly
  // like the feature not working.
  return `<script${attribute}>(()=>{let t=null;const p=${JSON.stringify(HMR_PATH)};const tick=async()=>{try{const r=await fetch(p,{cache:'no-store'});if(r.ok){const n=(await r.text()).trim();if(t===null){t=n}else if(n!==t){location.reload();return}}}catch(e){}setTimeout(tick,1000)};tick()})()</script>`
}
