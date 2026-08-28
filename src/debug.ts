/**
 * Debug channels, off unless `NODE_DEBUG` names them — the shape AdonisJS
 * uses (`NODE_DEBUG=adonisjs:http`).
 *
 *   NODE_DEBUG=ream:http ream serve
 *   NODE_DEBUG=ream:* ream serve
 *
 * These are for the framework's own tracing: which route a request matched,
 * which middleware ran, what status came back. They are NOT request logging —
 * a production request log belongs to the app's logger (`ctx.logger`), which
 * is correlation-scoped and structured. Neither framework prints one by
 * default, and this is the switch for when you need to see the plumbing.
 *
 * `debuglog` returns a no-op when the channel is off, so an inactive probe
 * costs a call. Guard with `.enabled` anywhere the ARGUMENTS would cost
 * something to build — the per-request probes below all do.
 */

import { debuglog } from 'node:util'

/** Routing, middleware and response tracing. AdonisJS `adonisjs:http`. */
export const debugHttp = debuglog('ream:http')

/** Boot: providers, preloads, container bindings. AdonisJS `adonisjs:core`. */
export const debugCore = debuglog('ream:core')
