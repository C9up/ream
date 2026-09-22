/**
 * The import graph a hot reload reasons over, and what it decides.
 *
 * Owned here rather than taken from `hot-hook`, which used to do this job. The
 * package is 655 lines and four npm dependencies, and it had to be installed by
 * every application because a dev-only loader has no business in a production
 * install of the framework — so a project created before that convention simply
 * lost hot reloading and was told nothing. The part that genuinely needs a
 * library is the part Node now provides itself: `module.registerHooks` for the
 * graph, `fs.watch` for the changes.
 *
 * NO node_modules dependency, deliberately: everything below is arithmetic on
 * paths.
 *
 * The graph is built by the resolver as the program runs, never by reading
 * files. A `resolve` hook is handed the importer and the imported, which is
 * exactly an edge, and it sees dynamic imports as they happen — a static parse
 * of the source could only guess at those.
 */

/** A module's place in the graph: who imports it, and which version is live. */
interface Node {
  /** Modules that imported this one. The graph is walked upward, so this is the direction stored. */
  readonly importers: Set<string>
  /** Bumped on invalidation; appended to the URL so the loader fetches the file again. */
  version: number
}

/** What a change to one file means. */
export type Decision =
  | { kind: 'swap'; invalidated: string[] }
  | { kind: 'reload'; file: string; reason: 'outside-boundaries' | 'restart-list' }
  | { kind: 'ignore' }

export class HotGraph {
  readonly #nodes = new Map<string, Node>()
  readonly #isBoundary: (file: string) => boolean
  readonly #isRestart: (file: string) => boolean

  constructor(options: {
    isBoundary: (file: string) => boolean
    isRestart: (file: string) => boolean
  }) {
    this.#isBoundary = options.isBoundary
    this.#isRestart = options.isRestart
  }

  #node(file: string): Node {
    let node = this.#nodes.get(file)
    if (node === undefined) {
      node = { importers: new Set(), version: 0 }
      this.#nodes.set(file, node)
    }
    return node
  }

  /** Record that `importer` imported `file`. Called from the resolve hook. */
  link(file: string, importer: string | undefined): void {
    const node = this.#node(file)
    if (importer !== undefined && importer !== file) node.importers.add(importer)
  }

  /** The version to hang off the URL, or 0 while the module has never been invalidated. */
  version(file: string): number {
    return this.#nodes.get(file)?.version ?? 0
  }

  /** Whether the resolver has ever seen this file. */
  knows(file: string): boolean {
    return this.#nodes.has(file)
  }

  /**
   * What to do about `file` having changed.
   *
   * Walks up from the changed file collecting what has to be re-imported, and
   * stops at each boundary: a boundary is imported dynamically, so the next
   * import of it re-resolves, and with it everything below that was collected
   * on the way. A path that reaches a module nobody imports without crossing a
   * boundary cannot be re-imported by anyone, and that is a full reload.
   *
   * Deciding before invalidating matters: a decision that turns out to be a
   * full reload must leave no version bumped behind, or a later swap would
   * hand the caller a URL for a module the process never re-imported.
   */
  decide(file: string): Decision {
    if (this.#isRestart(file)) return { kind: 'reload', file, reason: 'restart-list' }
    if (!this.#nodes.has(file)) return { kind: 'ignore' }

    const collected = new Set<string>()
    const queue = [file]
    while (queue.length > 0) {
      const current = queue.pop()
      if (current === undefined || collected.has(current)) continue
      collected.add(current)
      // A boundary is where the walk stops: whoever imports it does so
      // dynamically and will ask for it again.
      if (this.#isBoundary(current)) continue
      const importers = this.#nodes.get(current)?.importers
      if (importers === undefined || importers.size === 0) {
        return { kind: 'reload', file, reason: 'outside-boundaries' }
      }
      for (const importer of importers) queue.push(importer)
    }

    for (const path of collected) this.#node(path).version += 1
    return { kind: 'swap', invalidated: [...collected] }
  }
}
