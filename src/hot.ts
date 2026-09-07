/**
 * Dev-only entry hook: hot module replacement for the running server.
 *
 * `ream dev` loads this before the application entry:
 *
 *   node --import @swc-node/register/esm-register --import @c9up/ream/hot bin/server.ts
 *
 * It is a thin shim over `hot-hook`, which does the actual work: it registers
 * an ESM loader that tracks the import graph, and when a file inside a declared
 * boundary changes it invalidates just that module instead of the process. The
 * `hotHook` key in the application's `package.json` configures it, exactly as
 * upstream reads it.
 *
 * NAMED DEVIATION — why this file exists at all.
 *
 * Upstream's dev server is itself a Node process: it forks the app, so the two
 * talk over Node's IPC channel, and `hot-hook` reports a change it cannot swap
 * by calling `process.send({ type: 'hot-hook:full-reload' })`. Our dev server is
 * a Rust binary. A process it spawns has NO IPC channel, so `process.send` is
 * `undefined` and that message goes nowhere: the server would keep serving the
 * old module and say nothing.
 *
 * `hot.init()` takes an `onFullReloadAsked` callback for exactly this case, and
 * that is the whole of the shim: turn "I cannot hot-swap this" into an exit
 * code the Rust parent understands and restarts on. Everything else is
 * upstream's behaviour, unmodified.
 */

/** Exit code meaning "restart me" — see `EXIT_RESTART` in the CLI's dev module. */
const FULL_RELOAD_EXIT_CODE = 75

interface HotHook {
  init(options: {
    rootDirectory: string
    root?: string
    boundaries?: string[]
    restart?: string[]
    ignore?: string[]
    throwWhenBoundariesAreNotDynamicallyImported?: boolean
    onFullReloadAsked?: () => void
  }): Promise<void>
}

interface HotHookConfig {
  root?: string
  boundaries?: string[]
  restart?: string[]
  ignore?: string[]
  throwWhenBoundariesAreNotDynamicallyImported?: boolean
}

/** Read `hotHook` out of the application's package.json, with no assumptions. */
function readConfig(pkg: unknown): HotHookConfig {
  if (typeof pkg !== 'object' || pkg === null) return {}
  const raw = Reflect.get(pkg, 'hotHook')
  if (typeof raw !== 'object' || raw === null) return {}
  const stringArray = (key: string): string[] | undefined => {
    const value = Reflect.get(raw, key)
    if (!Array.isArray(value)) return undefined
    return value.filter((entry): entry is string => typeof entry === 'string')
  }
  const root = Reflect.get(raw, 'root')
  const strict = Reflect.get(raw, 'throwWhenBoundariesAreNotDynamicallyImported')
  return {
    root: typeof root === 'string' ? root : undefined,
    boundaries: stringArray('boundaries'),
    restart: stringArray('restart'),
    ignore: stringArray('ignore'),
    throwWhenBoundariesAreNotDynamicallyImported: typeof strict === 'boolean' ? strict : undefined,
  }
}

const { readFile } = await import('node:fs/promises')
const { dirname, resolve } = await import('node:path')

const packageJsonPath = resolve(process.cwd(), 'package.json')
let config: HotHookConfig = {}
try {
  config = readConfig(JSON.parse(await readFile(packageJsonPath, 'utf8')))
} catch {
  // No package.json, or unreadable: hot-hook still works, it just has no
  // boundaries, so every change asks for a restart. That is the old
  // behaviour, not a failure worth stopping dev over.
}

// `hot-hook` is an optional peer, declared by the application because it is a
// dev dependency there and has no business in a production install. Imported by
// specifier built at runtime so a production bundle never resolves it.
function isHotHook(value: unknown): value is HotHook {
  return (
    typeof value === 'object' && value !== null && typeof Reflect.get(value, 'init') === 'function'
  )
}

// `hot-hook` belongs to the APPLICATION: it is a dev dependency there and has
// no business in a production install of the framework. So it is resolved from
// the project directory rather than from this file — under pnpm's strict layout
// a bare `import("hot-hook")` here looks inside @c9up/ream and finds nothing.
// It is the same reason upstream passes `hot-hook/register` from the app's own
// cwd instead of re-exporting it from the framework.
const { createRequire } = await import('node:module')
const { pathToFileURL } = await import('node:url')

let hot: HotHook | undefined
try {
  const resolved = createRequire(packageJsonPath).resolve('hot-hook')
  const module: unknown = await import(pathToFileURL(resolved).href)
  const candidate =
    typeof module === 'object' && module !== null ? Reflect.get(module, 'hot') : undefined
  if (!isHotHook(candidate)) {
    throw new Error('hot-hook did not expose a `hot` object with init()')
  }
  hot = candidate
} catch (error) {
  // Loud, and it names the fix. Silence here would start a perfectly healthy
  // server that never picks up an edit, which reads as "HMR is broken" rather
  // than "HMR is not installed".
  //
  // It does NOT throw: a dev server that refuses to start is worse than one
  // without hot reloading, and the CLI only loads this file when it has
  // already seen hot-hook in the project — so reaching here means it went
  // missing under a running session.
  console.error(
    `[ream] hot module replacement is unavailable: ${error instanceof Error ? error.message : String(error)}\n` +
      '[ream] Install it with: pnpm add -D hot-hook, then restart `ream dev`.\n' +
      '[ream] Until then the server runs, but an edit will not be picked up.',
  )
}

await hot?.init({
  ...config,
  rootDirectory: dirname(packageJsonPath),
  root: config.root ? resolve(dirname(packageJsonPath), config.root) : undefined,
  // The one line that is ours. `process.send` does not exist under a Rust
  // parent, so upstream's notification is dropped; exiting on a known code is
  // how the CLI learns it must restart.
  onFullReloadAsked: () => process.exit(FULL_RELOAD_EXIT_CODE),
})
