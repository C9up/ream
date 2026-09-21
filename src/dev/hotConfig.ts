/**
 * Reading `hotHook` out of the application's package.json.
 *
 * The boundaries are the APPLICATION's to declare, as they are upstream: they
 * depend on a layout the framework does not own, and hot-hook requires every
 * file matching one to be dynamically imported — a glob that also catches a
 * statically imported service reports `shouldBeReloadable` and costs a FULL
 * reload, worse than the restart it replaced. `ream new` writes the block;
 * `ream doctor` reports its absence.
 *
 * Extracted from the loader entry so the parsing can be tested: that entry
 * registers an ESM loader the moment it is imported, which a test cannot undo.
 */

export interface HotHookConfig {
  root?: string
  boundaries?: string[]
  restart?: string[]
  ignore?: string[]
  throwWhenBoundariesAreNotDynamicallyImported?: boolean
}

/** Read `hotHook` out of a parsed package.json, with no assumptions. */
export function readHotHookConfig(pkg: unknown): HotHookConfig {
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
