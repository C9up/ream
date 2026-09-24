/**
 * Dev-only entry hook: hot module replacement for the running server.
 *
 * `ream dev` loads this before the application entry:
 *
 *   node --import @swc-node/register/esm-register --import @c9up/ream/hot bin/server.ts
 *
 * It replaces a module that changed instead of the process that was serving it,
 * so the container, the pools and the connections survive a save.
 *
 * NAMED DEVIATION — this is ream's own, where AdonisJS uses `hot-hook`.
 *
 * Upstream ships that package in its starter kit, which means every application
 * installs it, and one created before the convention existed silently loses hot
 * reloading. The parts that once justified a library are now in Node:
 * `module.registerHooks` gives the import graph, `fs.watch` gives the changes.
 * What is left is the decision of what to invalidate, which is this file and
 * its three neighbours — and no entry in anyone's `package.json`.
 *
 * The graph comes from the resolver rather than from reading files: a resolve
 * hook is handed the importer and the imported, which is exactly an edge, and
 * it sees a dynamic import at the moment it happens rather than guessing at it
 * from the source.
 */

import { existsSync, writeSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { dirname, relative, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { fullReloadNotice, invalidatedNotice } from './dev/fullReload.js'
import { hotReloadHappened } from './dev/hmr.js'
import { readHotHookConfig } from './dev/hotConfig.js'
import { globMatcher } from './dev/hotGlob.js'
import { HotGraph } from './dev/hotGraph.js'
import { watchProject } from './dev/hotWatcher.js'
import { envFileNames } from './env/loadEnvFiles.js'

/** Exit code meaning "restart me" — see `EXIT_RESTART` in the CLI's dev module. */
const FULL_RELOAD_EXIT_CODE = 75

/** The query parameter that makes the loader fetch a module again. */
const VERSION_PARAM = 'ream_hot'

/** Directories a project keeps its own code in — the CLI watches the same list. */
const WATCH_DIRS = ['app', 'bin', 'config', 'start', 'database', 'providers', 'commands']

const packageJsonPath = resolvePath(process.cwd(), 'package.json')
const root = dirname(packageJsonPath)

let config = {}
try {
  config = readHotHookConfig(JSON.parse(await readFile(packageJsonPath, 'utf8')))
} catch {
  // No package.json, or unreadable: a project with no boundaries declared gets
  // a working server that restarts on change, which is the old behaviour.
}
const { boundaries = [], restart = [] } = config as { boundaries?: string[]; restart?: string[] }

// Env files are not modules: nothing imports one, so the graph never sees them
// and an edit to `.env` did nothing at all — the values are read once, at boot.
// They always restart.
const restartFiles = new Set(
  envFileNames()
    .map((name) => resolvePath(root, name))
    .filter((file) => existsSync(file)),
)

/**
 * `metaFiles` entries that asked for a restart.
 *
 * Non-module files the application owns — translations, view templates — live
 * in `reamrc.ts` because the BUILD has to copy them. A change to one is
 * invisible to the import graph, so the only way it can do anything in
 * development is by being named here.
 *
 * `reloadServer: false` is the interesting default, and the one upstream picks
 * for translations: the entry exists so the file ships, and an edit does NOT
 * restart. NAMED DEVIATION — upstream still logs such a change, because its
 * watcher covers the whole project anyway. This one watches a fixed list of
 * directories on purpose (`resources/` belongs to the asset watcher, and a
 * stylesheet edit must not restart the server), so a `false` entry is simply
 * not watched. The observable behaviour is the same: nothing happens.
 */
async function readReloadPatterns(): Promise<string[]> {
  try {
    const rc = (await import(pathToFileURL(resolvePath(root, 'reamrc.ts')).href)) as {
      default?: { metaFiles?: Array<{ pattern?: unknown; reloadServer?: unknown }> }
    }
    return (rc.default?.metaFiles ?? [])
      .filter((entry) => entry.reloadServer === true && typeof entry.pattern === 'string')
      .map((entry) => String(entry.pattern))
  } catch {
    // No rc file, or one that does not load. The server itself reports a broken
    // rc far more clearly than the loader could, and a dev server that refuses
    // to start because of a watch list helps nobody.
    return []
  }
}

const reloadPatterns = await readReloadPatterns()

/**
 * The directory a pattern lives under — everything before its first wildcard.
 *
 * `resources/lang/**\/*.json` is watched as `resources/lang`. Watching the
 * project root instead would pull in `node_modules` and the build output.
 */
function watchRootOf(pattern: string): string {
  const segments = pattern.replace(/^\.\//, '').split('/')
  const fixed: string[] = []
  for (const segment of segments) {
    if (/[*?{[]/.test(segment)) break
    fixed.push(segment)
  }
  // A pattern that is a bare glob has no directory to narrow to.
  return fixed.slice(0, -1).join('/') || fixed.join('/')
}

const relativeToRoot = (file: string): string => relative(root, file).replace(/\\/g, '/')
const matchesBoundary = globMatcher(boundaries)
const matchesRestartGlob = globMatcher([...restart, ...reloadPatterns])

const graph = new HotGraph({
  isBoundary: (file) => matchesBoundary(relativeToRoot(file)),
  isRestart: (file) => restartFiles.has(file) || matchesRestartGlob(relativeToRoot(file)),
})

/**
 * Track every edge the resolver reports, and hand back a versioned URL for a
 * module that has been invalidated.
 *
 * The version travels in the URL because that is the only handle V8 offers: a
 * module is keyed by its URL, so a different one is a different module. The
 * parameter is stripped off the importer before delegating, or a relative
 * specifier would be resolved against a URL that does not name a directory.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    let parentURL = context.parentURL
    let parentPath: string | undefined
    if (typeof parentURL === 'string' && parentURL.startsWith('file:')) {
      const url = new URL(parentURL)
      if (url.searchParams.has(VERSION_PARAM)) {
        url.searchParams.delete(VERSION_PARAM)
        parentURL = url.href
      }
      parentPath = fileURLToPath(url)
    }

    const result = nextResolve(specifier, { ...context, parentURL })
    if (!result.url.startsWith('file:')) return result

    const resolved = new URL(result.url)
    resolved.searchParams.delete(VERSION_PARAM)
    const file = fileURLToPath(resolved)
    graph.link(file, parentPath)

    const version = graph.version(file)
    if (version === 0) return result
    resolved.searchParams.set(VERSION_PARAM, String(version))
    return { ...result, url: resolved.href }
  },
})

/** Print a line that must survive the exit on the very next statement. */
function sayNow(line: string): void {
  // Synchronously: a piped stdout — what `ream dev` hands this process when it
  // runs an asset watcher alongside — is asynchronous, and the line would be
  // dropped on the way out.
  try {
    writeSync(1, `${line}\n`)
  } catch {
    // The parent can close the pipe first on Ctrl-C. Losing the line is fine.
  }
}

watchProject({
  root,
  directories: [
    ...WATCH_DIRS,
    // Whatever a `reloadServer: true` entry named, and nothing else: the
    // directories above are the ones the graph can reason about.
    ...reloadPatterns.map(watchRootOf).filter((dir) => dir !== ''),
  ],
  files: [...restartFiles].map((file) => relative(root, file)),
  // A watcher that quietly stops watching is how this went unnoticed for a
  // release: the first save swapped, the rest did nothing at all.
  onWarning: (message) => sayNow(`[ream] hot reload — ${message}`),
  onChange: (file) => {
    const decision = graph.decide(file)
    if (decision.kind === 'ignore') {
      // Said, not swallowed. A file the running process never imported cannot
      // be swapped into it, and "I saved and nothing happened" is the same
      // symptom as a broken watcher — the developer deserves to know which.
      sayNow(`[ream] no reload — ${relativeToRoot(file)} is not imported by the running app`)
      return
    }
    if (decision.kind === 'reload') {
      sayNow(fullReloadNotice(decision.file, decision.reason, relativeToRoot))
      // Exiting on a known code is how the Rust parent learns it must restart —
      // see `EXIT_RESTART` in the CLI's dev module.
      process.exit(FULL_RELOAD_EXIT_CODE)
    }
    // The router caches a promoted controller per route, and the kernel drops
    // that cache when this counter moves. Without it the swap happens and the
    // process keeps serving the class it promoted: a stable PID and stale
    // output, which is exactly how it was first reported.
    hotReloadHappened()
    sayNow(invalidatedNotice(file, relativeToRoot))
  },
})
