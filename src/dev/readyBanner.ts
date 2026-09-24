/**
 * What the dev server says once it is listening.
 *
 * Upstream prints a sticker the moment the child reports ready: the address,
 * the mode, how long the boot took. Read off `@adonisjs/assembler`'s build:
 *
 *     this.ui.sticker()
 *       .add(`Server address: ${colors.cyan(serverUrl)}`)
 *       .add(`Mode: ${colors.cyan(this.mode)}`)
 *       .add(`Ready in: ${colors.cyan(prettyHrtime(message.duration))}`)
 *
 * Ours says the same three things. What it does NOT say is upstream's fourth
 * line, `Press h to show help` — there are no keyboard shortcuts here, and
 * offering a key that does nothing is worse than not offering it.
 *
 * Printed from the application rather than from the `ream dev` parent, which
 * is where upstream prints it. The parent is a Rust process here and the port
 * is not its to know: a dev server that found 3000 taken binds 3001, and only
 * the process that bound it can say so. Upstream solves the same problem by
 * having the child send the port over IPC — the address it prints is the
 * child's either way.
 */

import { lumen } from '@c9up/lumen'

/** Whether `ream dev` is what started this process. */
export function inDevServer(): boolean {
  return process.env.REAM_DEV === 'true'
}

export interface ReadyBanner {
  /** The host the server bound, as the Ignitor resolved it. */
  host: string
  port: number
  /** `HMR` when the loader is swapping modules, `watch` when it only restarts. */
  mode: string
  /** Milliseconds from process start to listening. */
  bootMs?: number
}

/**
 * The lines of the sticker, so a test can read them without a terminal.
 *
 * `localhost` rather than `0.0.0.0` in the URL: a bound address of `0.0.0.0`
 * means every interface, and printing it gives you a link that does not open.
 */
export function readyBannerLines(banner: ReadyBanner): string[] {
  const ui = lumen()
  const shown = banner.host === '0.0.0.0' || banner.host === '::' ? 'localhost' : banner.host
  const lines = [
    `Server address: ${ui.colors.cyan(`http://${shown}:${banner.port}`)}`,
    `Mode: ${ui.colors.cyan(banner.mode)}`,
  ]
  if (banner.bootMs !== undefined) {
    lines.push(`Ready in: ${ui.colors.cyan(formatBootTime(banner.bootMs))}`)
  }
  return lines
}

/** Print it, the way upstream prints its sticker. */
export function printReadyBanner(banner: ReadyBanner): void {
  const ui = lumen()
  const sticker = ui.sticker()
  for (const line of readyBannerLines(banner)) sticker.add(line)
  sticker.render()
}

/**
 * `412 ms`, `1.2 s` — upstream runs the duration through `pretty-hrtime`.
 *
 * Not that dependency: this prints one number once per boot, and the package
 * is 60 lines of unit selection for a case we have exactly one of.
 */
function formatBootTime(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(1)} s`
}
