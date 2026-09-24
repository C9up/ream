/**
 * What the dev server says when a file changed.
 *
 * Upstream's vocabulary, read off `@adonisjs/assembler`'s build rather than
 * invented: a module the loader swapped in place is `invalidated <path>`, and
 * one that could not be — so the process restarts — is `update <path>`. The
 * word is green, the path is not, and that is the whole line.
 *
 * It used to carry the reason as well: which `hotHook` entry the file fell
 * outside of. That read well the first time and was noise every time after,
 * and it is not what upstream prints. What the reason existed for — a boot
 * banner appearing twice with nothing to explain it — is answered by the line
 * being there at all.
 *
 * The terminal is cleared first, as upstream clears it, so the logs after a
 * restart are the only ones on screen. `ream dev --no-clear` turns it off —
 * `ace serve --no-clear` is the same flag for the same reason.
 *
 * Kept apart from the loader entry so it can be tested: importing that entry
 * registers module hooks, which a test cannot undo.
 */

import { ansiColors, silentColors, supportsColor } from '@c9up/lumen'

/** Why a change could not be swapped in place. */
export type ReloadReason = 'outside-boundaries' | 'restart-list'

/**
 * Coloured only when the stream takes colour.
 *
 * Decided per call rather than once at import: this module is loaded by the
 * hot entry long before anything knows where its output goes, and a cached
 * answer would be the wrong one for a piped run.
 */
function colors(): ReturnType<typeof ansiColors> {
  return supportsColor(process.stdout) ? ansiColors() : silentColors()
}

/**
 * Wipe the terminal, the way upstream does before a restart.
 *
 * `\u001Bc` is the full reset upstream writes, not a scroll — the point is
 * that what follows is the only thing on screen. Off when the dev server was
 * started with `--no-clear`, and off when nothing is watching a terminal at
 * all: writing escape codes into a pipe leaves them in the file.
 */
export function clearScreen(): void {
  if (process.env.REAM_DEV_CLEAR_SCREEN === 'false') return
  if (!process.stdout.isTTY) return
  process.stdout.write('\u001Bc')
}

/**
 * The line printed when a module was swapped in the running process.
 *
 * @param file - absolute path of the file that changed.
 * @param relativise - turns it into the path the editor shows.
 */
export function invalidatedNotice(file: string, relativise: (file: string) => string): string {
  return `${colors().green('invalidated')} ${relativise(file)}`
}

/**
 * The line printed before the process restarts.
 *
 * `reason` is not in the text — it is what the caller already decided, and
 * upstream prints one word — but it stays in the signature because the caller
 * has it and a future line may want it.
 */
export function fullReloadNotice(
  file: string,
  _reason: ReloadReason,
  relativise: (file: string) => string,
): string {
  return `${colors().green('update')} ${relativise(file)}`
}
