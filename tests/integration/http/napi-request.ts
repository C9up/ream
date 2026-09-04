/**
 * Reading the request the native server hands a handler.
 *
 * The binding declares it as `Record<string, unknown>`, because that is all the
 * Rust promises: the request crosses as a `serde_json::Value` turned into a
 * JsObject, and no Rust struct describes it. Each test then wants the five
 * fields it actually uses, so ask for them here rather than annotating the
 * handler with a shape nobody guaranteed.
 */

/** What every test reads off a request. */
export interface NapiRequest {
  method: string
  path: string
  query: string
  headers: Record<string, string>
  body: string
}

function text(raw: Record<string, unknown>, name: string): string {
  const value = raw[name]
  return typeof value === 'string' ? value : ''
}

function headerMap(raw: Record<string, unknown>): Record<string, string> {
  const value = raw.headers
  if (typeof value !== 'object' || value === null) return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry
  }
  return out
}

/** The five fields, from whatever the boundary handed over. */
export function asRequest(raw: Record<string, unknown>): NapiRequest {
  return {
    method: text(raw, 'method'),
    path: text(raw, 'path'),
    query: text(raw, 'query'),
    headers: headerMap(raw),
    body: text(raw, 'body'),
  }
}

/** A raw field the five above do not cover (`multipart`, `bodyBuffer`, …). */
export function rawField(raw: Record<string, unknown>, name: string): unknown {
  return raw[name]
}
