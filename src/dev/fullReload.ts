/**
 * Saying why the process is about to restart.
 *
 * A change the loader cannot swap in place becomes an exit code the dev server
 * restarts on. From the terminal the only trace of it was the boot banner
 * printing itself a second time — which reads as a server rebooting on its own
 * rather than as a file that fell outside `hotHook.boundaries`. Upstream's dev
 * server logs the file it reloaded for; this is that line.
 *
 * Kept apart from the loader entry so it can be tested: importing that entry
 * registers module hooks, which a test cannot undo.
 */

/** Why a change could not be swapped in place. */
export type ReloadReason = 'outside-boundaries' | 'restart-list'

/**
 * The line to print before restarting.
 *
 * @param file - absolute path of the file that changed.
 * @param relativise - turns it into the path the editor shows, so the line can
 *   be read at a glance.
 */
export function fullReloadNotice(
  file: string,
  reason: ReloadReason,
  relativise: (file: string) => string,
): string {
  const why =
    reason === 'restart-list'
      ? ' (it is on `hotHook.restart`, which always restarts)'
      : ' (nothing importing it is inside a `hotHook.boundaries` entry, so it could not be swapped)'
  return `[ream] full reload — ${relativise(file)}${why}`
}
