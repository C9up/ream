/**
 * The keys the dev server answers to.
 *
 * Upstream's set, read off `@adonisjs/assembler`'s build: `r` restarts, `c`
 * clears, `o` opens the browser, `h` shows the list, and Ctrl-C or Ctrl-D
 * quits. Same keys, same order, same words.
 *
 * Owned by the application rather than by the `ream dev` parent, which is
 * where upstream owns it — the same split as the ready sticker, and for the
 * same reason: `o` needs the address, and a port found by scanning past a
 * taken 3000 is known only to the process that bound it. Everything else
 * follows from there, because this process already has what each key needs:
 * exiting on the restart code is what makes the parent start it again, and
 * the graceful shutdown is already wired to a signal.
 *
 * NO dependency for opening a browser. Upstream imports `open`; this spawns
 * the platform's opener, which is the one thing that package does on the three
 * platforms a dev server runs on.
 */

import { spawn } from 'node:child_process'
import { lumen } from '@c9up/lumen'
import { clearScreen } from './fullReload.js'

/** The exit code the `ream dev` parent restarts on. */
export const RESTART_EXIT_CODE = 75

interface Shortcut {
  key: string
  description: string
  handler: () => void
}

export interface ShortcutsOptions {
  /** Where the server is listening, for `o`. */
  url?: string
  /** Leave the process the way a restart leaves it. Defaults to exiting. */
  onRestart?: () => void
  /** End the session. Defaults to exiting through the normal shutdown. */
  onQuit?: () => void
}

/** The lines `h` prints, so a test can read them without a terminal. */
export function helpLines(): string[] {
  return ['Available shortcuts:', ...shortcutsFor({}).map((s) => `· ${s.key}: ${s.description}`)]
}

function shortcutsFor(options: ShortcutsOptions): Shortcut[] {
  const ui = lumen()
  return [
    {
      key: 'r',
      description: 'restart server',
      handler: () => {
        ui.logger.log('')
        ui.logger.info('Manual restart triggered...')
        // Exiting on the restart code IS the restart: the parent loops on it,
        // which is the same path a change outside the boundaries takes.
        if (options.onRestart) options.onRestart()
        else process.exit(RESTART_EXIT_CODE)
      },
    },
    {
      key: 'c',
      description: 'clear console',
      handler: () => {
        clearScreen()
        ui.logger.info('Console cleared')
      },
    },
    {
      key: 'o',
      description: 'open in browser',
      handler: () => {
        if (options.url === undefined) {
          ui.logger.warning('No server address to open')
          return
        }
        ui.logger.log('')
        ui.logger.info(`Opening ${options.url}...`)
        openBrowser(options.url)
      },
    },
    {
      key: 'h',
      description: 'show this help',
      handler: () => {
        ui.logger.log('')
        for (const line of helpLines()) ui.logger.log(line)
      },
    },
  ]
}

/** What to do with one keypress. Exported so the mapping is testable. */
export function handleKey(key: string, options: ShortcutsOptions = {}): boolean {
  // \u0003 is Ctrl-C and \u0004 is Ctrl-D. Raw mode means no signal is raised
  // for either, so the process would sit there unkillable without this.
  if (key === '\u0003' || key === '\u0004') {
    if (options.onQuit) options.onQuit()
    else process.kill(process.pid, 'SIGINT')
    return true
  }
  const shortcut = shortcutsFor(options).find((entry) => entry.key === key)
  if (shortcut === undefined) return false
  shortcut.handler()
  return true
}

/**
 * Listen for keys. Answers a function that stops listening.
 *
 * A no-op when stdin is not a terminal — `ream dev` piped into a file has no
 * keyboard, and raw mode on a pipe throws.
 */
export function installShortcuts(options: ShortcutsOptions = {}): () => void {
  if (!process.stdin.isTTY) return () => {}

  const onData = (data: Buffer | string): void => {
    handleKey(data.toString(), options)
  }
  process.stdin.setRawMode(true)
  process.stdin.on('data', onData)
  // Nothing should stay alive for a keyboard: a server that finished its work
  // must be able to exit with a listener still attached.
  process.stdin.unref()

  return () => {
    process.stdin.setRawMode(false)
    process.stdin.removeListener('data', onData)
    process.stdin.pause()
  }
}

/**
 * Hand the URL to whatever opens links here.
 *
 * Detached and ignored: an opener that writes to stderr, or outlives the dev
 * server, must not take the terminal or the exit with it.
 */
function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  try {
    const child = spawn(command, [url], {
      detached: true,
      stdio: 'ignore',
      shell: process.platform === 'win32',
    })
    child.unref()
    child.on('error', () => {
      // No opener on this machine — a headless container, say. The address was
      // printed a moment ago; losing the click is not worth a crash.
    })
  } catch {
    // Same.
  }
}
