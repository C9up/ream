/**
 * Saying why the process is about to restart.
 *
 * hot-hook reports a change it could not swap in place through `process.send`,
 * and `@c9up/ream/hot` turns that into an exit code the dev server restarts on.
 * From the terminal the only trace of it was the boot banner printing itself a
 * second time — which reads as a server rebooting on its own rather than as a
 * file that fell outside `hotHook.boundaries`. Upstream's dev server logs the
 * file it reloaded for; this is that line.
 *
 * Extracted from the loader entry so it can be tested: importing `hot.ts`
 * registers an ESM loader, which a test cannot undo.
 */

/** The path hot-hook blamed, whichever shape the message carries. */
function changedFile(message: object): string | undefined {
  // A file hot-hook cannot reload comes as `path`; the same full reload raised
  // because a module DECLINED hot replacement carries `paths` instead.
  const single = Reflect.get(message, 'path')
  if (typeof single === 'string' && single !== '') return single
  const many = Reflect.get(message, 'paths')
  if (!Array.isArray(many)) return undefined
  return many.find((entry): entry is string => typeof entry === 'string' && entry !== '')
}

/**
 * The line to print for a `hot-hook:full-reload` message, or `undefined` when
 * the message is not one.
 *
 * @param relativise - turns hot-hook's absolute path into the one the editor
 *   shows, so the line can be read at a glance.
 */
export function fullReloadNotice(
  message: unknown,
  relativise: (file: string) => string,
): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  if (Reflect.get(message, 'type') !== 'hot-hook:full-reload') return undefined

  const file = changedFile(message)
  const what = file === undefined ? 'a change could not be applied in place' : relativise(file)
  // hot-hook sets this when the file DOES match a boundary but a static import
  // reaches it: the glob is right and the import is not. That is a different
  // fix from "declare a boundary", and this flag is the only hint of it.
  const why =
    Reflect.get(message, 'shouldBeReloadable') === true
      ? ' (it matches a `hotHook.boundaries` entry, but something imports it statically, so it could not be swapped)'
      : ''
  return `[ream] full reload — ${what}${why}`
}
