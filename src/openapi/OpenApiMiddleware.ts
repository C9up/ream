/**
 * OpenApiMiddleware — serves the OpenAPI spec and Swagger UI.
 *
 * GET /api-docs → JSON spec
 * GET /docs → Swagger UI (HTML)
 */

import type { HttpContext } from '../http/HttpContext.js'

export interface OpenApiMiddlewareConfig {
  specPath?: string
  docsPath?: string
  /**
   * The OpenAPI spec, or a factory that builds it lazily on first request.
   * Pass a factory when the spec depends on routes registered AFTER this
   * middleware is mounted (the common case — `OpenApiProvider` passes
   * `() => generator.generate()`). The result is memoised after the first hit.
   */
  spec: Record<string, unknown> | (() => Record<string, unknown>)
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export class OpenApiMiddleware {
  #specPath: string
  #docsPath: string
  #specSource: Record<string, unknown> | (() => Record<string, unknown>)
  #specJson?: string
  #safeTitle?: string
  #safeSpecPathJs: string

  constructor(config: OpenApiMiddlewareConfig) {
    this.#specPath = config.specPath ?? '/api-docs'
    this.#docsPath = config.docsPath ?? '/docs'
    this.#specSource = config.spec
    this.#safeSpecPathJs = JSON.stringify(this.#specPath) // JS string literal — safe in <script>
  }

  /** Resolve (and memoise) the spec JSON + escaped title on first use. */
  #resolveSpec(): { json: string; safeTitle: string } {
    if (this.#specJson === undefined || this.#safeTitle === undefined) {
      const spec = typeof this.#specSource === 'function' ? this.#specSource() : this.#specSource
      this.#specJson = JSON.stringify(spec)
      const specInfo = spec.info
      const rawTitle =
        typeof specInfo === 'object' && specInfo !== null && 'title' in specInfo
          ? specInfo.title
          : undefined
      this.#safeTitle = escapeHtml(typeof rawTitle === 'string' ? rawTitle : 'API Docs')
    }
    return { json: this.#specJson, safeTitle: this.#safeTitle }
  }

  async handle(ctx: HttpContext, next: () => Promise<void>): Promise<void> {
    const path = ctx.request.path()

    if (path === this.#specPath && ctx.request.method() === 'GET') {
      this.sendSpec(ctx)
      return
    }

    if (path === this.#docsPath && ctx.request.method() === 'GET') {
      this.sendDocs(ctx)
      return
    }

    return next()
  }

  /** Answer with the JSON spec — what a route mounted on `specPath` calls. */
  sendSpec(ctx: HttpContext): void {
    ctx.response.header('Content-Type', 'application/json')
    ctx.response.status(200).send(this.#resolveSpec().json)
  }

  /** Answer with the Swagger UI page — what a route mounted on `docsPath` calls. */
  sendDocs(ctx: HttpContext): void {
    ctx.response.header('Content-Type', 'text/html')
    ctx.response.status(200).send(this.#renderSwaggerUi())
  }

  /**
   * Swagger UI from jsDelivr at an exact version, with each file's
   * Subresource Integrity hash: the browser refuses a file the CDN serves
   * different from the one hashed here. Moving the version means recomputing
   * both hashes: `curl -s <url> | openssl dgst -sha384 -binary | openssl base64 -A`.
   */
  #renderSwaggerUi(): string {
    const { safeTitle } = this.#resolveSpec()
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${safeTitle}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.35.1/swagger-ui.css" integrity="sha384-WlYgdmXYOOBWL5apwjDEZwN+U3HmXSSu5R6V5aGxEcf7z+KuRNwBhoxKVN1i3D5I" crossorigin="anonymous">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.35.1/swagger-ui-bundle.js" integrity="sha384-J5eKRXKO1KzUTPkO0GRmGH2WEYUg6SSZlufilxvTwI6nmhLumjNWFMby3QQnyobZ" crossorigin="anonymous"></script>
  <script>
    SwaggerUIBundle({
      url: ${this.#safeSpecPathJs},
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: 'BaseLayout',
    })
  </script>
</body>
</html>`
  }
}
