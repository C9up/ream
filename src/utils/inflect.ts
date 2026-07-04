/**
 * Minimal zero-dependency string inflection — the two operations resourceful
 * routing needs from AdonisJS's `@poppinss/utils/string`: `snakeCase` (route
 * name normalisation) and `singular` (nested-resource param naming, `photos`
 * → `photo_id`).
 *
 * Deviation from AdonisJS (named): `singular` covers regular English plurals
 * only (`-ies→-y`, `-(s|x|z|ch|sh)es→drop es`, trailing `-s→drop`). Irregular
 * plurals (`people→person`, `geese→goose`) are NOT handled — resource names in
 * REST APIs are overwhelmingly regular, and a full inflector (irregular tables,
 * uncountables) would be a dependency-sized rabbit hole for a niche case.
 */

/** Convert `camelCase`/`PascalCase`/`kebab-case`/spaced text to `snake_case`. */
export function snakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase()
}

/** Singularize a regular English plural (see module deviation note). */
export function singular(word: string): string {
  if (word.length > 3 && /ies$/i.test(word)) return word.replace(/ies$/i, 'y')
  if (/(?:s|x|z|ch|sh)es$/i.test(word)) return word.replace(/es$/i, '')
  if (/ss$/i.test(word)) return word
  if (/s$/i.test(word)) return word.replace(/s$/i, '')
  return word
}
