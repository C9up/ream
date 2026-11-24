/**
 * The `Host` check in front of the framework's development pages.
 *
 * The profiler shows recorded requests — bodies, sessions, the signed-in user,
 * database bindings — and the reload stream lives next to it under
 * `/__ream/`. Without a `Host` check, DNS rebinding reads them: a page served
 * from `attacker.example`, whose name is then re-pointed at `127.0.0.1`, is
 * same-origin with the development server for the browser. So, as Vite's
 * `server.allowedHosts`, these pages answer only an IP literal, `localhost`, a
 * `.localhost` name, the bind host, or a name the application listed (a
 * leading `.` allows that domain and its subdomains); anything else gets
 * `403 Blocked request. This host ("<name>") is not allowed.`
 *
 * A request the browser marks cross-site (`Sec-Fetch-Site: cross-site`) is
 * refused as well: the toolbar and the reload stream are only ever requested
 * by the application's own pages.
 */

import { isIP } from 'node:net'

/** Where every page the framework serves in development lives. */
export const DEV_PAGES_PREFIX = '/__ream/'

export interface DevHostGuardOptions {
  /** Extra names to accept, or `true` for any (open to DNS rebinding). */
  allowedHosts?: readonly string[] | true
  /** The address the server binds, read when a request arrives. */
  bindHost?: () => string | undefined
}

/** The slice of the context the guard uses. */
export interface DevHostGuardContext {
  request: { url: () => string; header: (name: string) => string | undefined }
  response: {
    header: (name: string, value: string) => unknown
    send: (body: unknown) => unknown
    status: (code: number) => unknown
  }
}

export function devHostGuard(
  options: DevHostGuardOptions = {},
): (ctx: DevHostGuardContext, next: () => Promise<void>) => Promise<void> {
  return async (ctx, next) => {
    const path = ctx.request.url().split('?')[0] ?? ''
    if (!path.startsWith(DEV_PAGES_PREFIX) && path !== DEV_PAGES_PREFIX.slice(0, -1)) {
      await next()
      return
    }

    const host = ctx.request.header('host')
    if (!isHostAllowed(host, options)) {
      const name = (host ?? '').replace(/:\d+$/, '')
      refuse(ctx, `Blocked request. This host (${JSON.stringify(name)}) is not allowed.`)
      return
    }
    if (ctx.request.header('sec-fetch-site') === 'cross-site') {
      refuse(ctx, 'Blocked request. Cross-site requests to the development pages are not allowed.')
      return
    }
    await next()
  }
}

function refuse(ctx: DevHostGuardContext, message: string): void {
  ctx.response.status(403)
  ctx.response.header('content-type', 'text/plain; charset=utf-8')
  ctx.response.send(message)
}

/**
 * Vite's rule (`isHostAllowedInternal`). A request without `Host` is let
 * through, as Vite does: a browser always sends one, so it is not the
 * rebinding case.
 */
export function isHostAllowed(host: string | undefined, options: DevHostGuardOptions): boolean {
  if (host === undefined) return true
  if (options.allowedHosts === true) return true

  const trimmed = host.trim()
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    return end > 0 && isIP(trimmed.slice(1, end)) === 6
  }
  const colon = trimmed.indexOf(':')
  const hostname = (colon === -1 ? trimmed : trimmed.slice(0, colon)).toLowerCase()
  if (isIP(hostname) === 4) return true
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true

  const bind = options.bindHost?.()?.toLowerCase()
  if (bind !== undefined && bind === hostname) return true

  for (const allowed of options.allowedHosts ?? []) {
    const entry = allowed.toLowerCase()
    if (entry === hostname) return true
    if (entry.startsWith('.') && (entry.slice(1) === hostname || hostname.endsWith(entry))) {
      return true
    }
  }
  return false
}
