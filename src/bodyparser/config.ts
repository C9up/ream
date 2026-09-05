/**
 * `config/bodyparser.ts` — body-parsing limits and types, in the file the
 * config loader reads (`config/<name>.ts` → `config.get('<name>')`).
 *
 * @example
 *   // config/bodyparser.ts
 *   import { defineConfig } from '@c9up/ream/bodyparser/config'
 *
 *   export default defineConfig({
 *     multipart: { limit: '20mb' },
 *   })
 */

import type { BodyParserConfig } from './BodyParserMiddleware.js'

export function defineConfig(config: BodyParserConfig): BodyParserConfig {
  return config
}
