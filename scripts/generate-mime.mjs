/**
 * Regenerate `src/http/mime.ts` from mime-db.
 *
 * The table is data, not logic, and hand-maintaining it is how `.yaml` and
 * `.sql` went missing. `mime-types` reads the same two fields out of mime-db —
 * the resolved extension map and the per-type `charset` — so generating from
 * there keeps `contentType()` answering exactly what the package answered.
 *
 * mime-db and mime-types are dev-only: they are read HERE, at generation time,
 * and never imported by the framework.
 *
 *     node scripts/generate-mime.mjs
 */

import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const mimeTypes = require('mime-types')
const db = require('mime-db')
const dbVersion = require('mime-db/package.json').version

const here = dirname(fileURLToPath(import.meta.url))
const target = join(here, '..', 'src', 'http', 'mime.ts')

/**
 * Emitted in the package's own style — single quotes, no semicolons — so a
 * regenerated file is already what `biome check` wants and the diff after a
 * regeneration is the data that changed, nothing else.
 */
const quote = (value) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
/** An identifier when it is one, a quoted key otherwise (`7z`, `3gp`…). */
const key = (ext) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(ext) ? ext : quote(ext))

const extensions = Object.keys(mimeTypes.types).sort()
const rows = extensions.map((e) => `  ${key(e)}: ${quote(mimeTypes.types[e])},`).join('\n')

const charsets = Object.entries(db)
  .filter(([, entry]) => entry.charset)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([type, entry]) => `  ${quote(type)}: ${quote(entry.charset.toLowerCase())},`)
  .join('\n')

await writeFile(target, render({ rows, charsets, dbVersion, count: extensions.length }))
process.stdout.write(`mime.ts: ${extensions.length} extensions from mime-db ${dbVersion}\n`)

function render({ rows, charsets, dbVersion, count }) {
  return `/**
 * Content types for a response, resolved here rather than pulled in.
 *
 * \`response.type("txt")\` has to become \`text/plain; charset=utf-8\`, which is a
 * lookup table and one charset rule — the same job \`@c9up/archive\` already
 * does in its own table, so the framework was carrying a dependency for work
 * the ecosystem already owned.
 *
 * A hand-written table is what made that a regression rather than a saving:
 * it knew the extensions someone thought of, so \`.yaml\`, \`.sql\`, \`.opus\` and
 * \`.xhtml\` fell through and the caller's own string went out as the content
 * type. The tables below are GENERATED from mime-db instead, which is where
 * \`mime-types\` reads them too, so the resolution is the same one and stays
 * the same one.
 *
 * Regenerate with:
 *
 *     node scripts/generate-mime.mjs
 *
 * Do not edit {@link TYPES} or {@link CHARSETS} by hand.
 *
 * @generated from mime-db ${dbVersion} (${count} extensions)
 */

/** Extension → type. No leading dot; lowercase. */
const TYPES: Record<string, string> = {
${rows}
}

/**
 * Types that declare a charset of their own, lowercased.
 *
 * Everything else under \`text/\` defaults to utf-8; everything else has none.
 * That is mime-db's \`charset\` field plus \`mime-types\`' \`text/*\` fallback.
 */
const CHARSETS: Record<string, string> = {
${charsets}
}

/** The charset for a type, or \`undefined\` when it carries none. */
function charsetFor(type: string): string | undefined {
  const base = type.split(';')[0].trim().toLowerCase()
  const declared = CHARSETS[base]
  if (declared !== undefined) return declared
  return base.startsWith('text/') ? 'utf-8' : undefined
}

/** The type for a bare extension, or \`undefined\` when it is not one we know. */
export function lookupType(extension: string): string | undefined {
  const ext = extension.replace(/^.*\\./, '').toLowerCase()
  return TYPES[ext]
}

/**
 * A full \`Content-Type\` for an extension or a type (\`mime-types.contentType\`).
 *
 * Returns \`false\` for something it cannot resolve, as the package did, so the
 * caller keeps its existing fallback rather than writing \`content-type: false\`.
 */
export function contentType(input: string): string | false {
  if (input.length === 0) return false
  // Already a type — possibly with parameters the caller set itself.
  const type = input.includes('/') ? input : lookupType(input)
  if (type === undefined) return false
  if (type.includes('charset=')) return type
  const charset = charsetFor(type)
  return charset === undefined ? type : \`\${type}; charset=\${charset}\`
}
`
}
