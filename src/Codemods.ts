import * as fs from 'node:fs'
import * as path from 'node:path'
import { render as renderTemplate, type StubState } from './stubs/template.js'

export type { StubState }

export interface Codemods {
  addProvider(importPath: string): Promise<void>
  addMetaFile(pattern: string, reloadServer?: boolean): Promise<void>
  addEnvVars(vars: Record<string, string>): Promise<void>
  writeFile(filePath: string, content: string, options?: { force?: boolean }): Promise<void>
  makeUsingStub(
    stubsRoot: string,
    stubPath: string,
    state?: StubState,
    options?: { force?: boolean },
  ): Promise<GeneratedStub>
  registerCommand(importPath: string): Promise<void>
  registerMiddleware(importPath: string, options?: { tier?: 'server' | 'router' }): Promise<void>
}

/** What a stub may interpolate. Scalars only — a stub is text, not a program. */

/** Where a stub landed, and what it wrote there. */
export interface GeneratedStub {
  /** Relative to the project root. */
  path: string
  contents: string
}

/**
 * A stub, split into the destination it declares and the body it renders.
 *
 * The format is the one `ream-cli`'s generators already read, deliberately:
 * two stub dialects in one framework is a worse tax than the feature is worth.
 *
 *     ---
 *     to: config/visa.ts
 *     ---
 *     export default defineConfig({ ... })
 *
 * Adonis declares the same thing with `{{{ exports({ to: … }) }}}`, which is
 * JavaScript we cannot evaluate here — the front matter is that line, written
 * so a text substitution can read it.
 */
function splitFrontMatter(template: string): { to?: string; body: string } {
  const trimmed = template.replace(/^[\uFEFF\r\n]+/, '')
  if (!trimmed.startsWith('---')) return { body: template }

  const after = trimmed.slice(3).replace(/^\r?\n/, '')
  const end = after.indexOf('\n---')
  if (end === -1) {
    throw new Error('[configure] stub front matter opened with `---` but never closed')
  }
  const block = after.slice(0, end)
  const body = after.slice(end + 4).replace(/^\r?\n/, '')

  let to: string | undefined
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const separator = line.indexOf(':')
    if (separator === -1) {
      throw new Error(`[configure] unreadable stub front-matter line: \`${line}\``)
    }
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (key === 'to') to = value
    // Any other key is ignored rather than refused: a stub written for a
    // later version of this loader must not break the current one.
  }
  return to === undefined ? { body } : { to, body }
}

type MiddlewareTier = 'server' | 'router'

function isMiddlewareTier(value: unknown): value is MiddlewareTier {
  return value === 'server' || value === 'router'
}

function findTierBlock(
  content: string,
  tier: MiddlewareTier,
): { start: number; end: number } | null {
  // Word-boundary prefix `(?:^|[^A-Za-z0-9_$.])` rejects `customServer.use` / `myRouter.use`
  // when scanning for the canonical `server` / `router` tier. The `.` exclusion also rejects
  // `obj.server.use` shapes. Match[1] captures the literal `<tier>.use([` so we can compute
  // the post-`[` cursor without including the boundary char.
  const marker = new RegExp(
    `(?:^|[^A-Za-z0-9_$.])(${tier}\\.use\\s*\\(\\s*(?:\\/\\*[\\s\\S]*?\\*\\/\\s*)?\\[)`,
  )
  const match = marker.exec(content)
  if (match === null || match[1] === undefined) return null
  const start = match.index + match[0].length
  // The array close pattern `\]\s*,?\s*\)` matches `])`, `],)`, `],\n)`, `]\n)` — every
  // canonical kernel shape produced by `ream new` or hand-formatted by Prettier. Using
  // this pattern (vs a bare `]`) avoids early-truncating the slice on nested `]` inside
  // an array entry — important for the dedup window since we read the slice content for
  // cross-tier collision detection AND per-tier idempotency.
  const closeMatch = /\]\s*,?\s*\)/.exec(content.slice(start))
  if (closeMatch === null) return null
  return { start, end: start + closeMatch.index }
}

/**
 * Detect line ending (CRLF on Windows checkouts, LF elsewhere) so codemods preserve the file's existing convention.
 * Majority-based: a stray CRLF in an otherwise-LF file must not flip the whole insertion to CRLF.
 */
function detectLineEnding(content: string): '\r\n' | '\n' {
  const crlfCount = (content.match(/\r\n/g) ?? []).length
  const bareLfCount = (content.match(/(?<!\r)\n/g) ?? []).length
  return crlfCount > bareLfCount ? '\r\n' : '\n'
}

/**
 * Refuse to follow a symlink that escapes the project root. Mirrors the guard `writeFile` enforces
 * (lines 137-155) so `registerCommand` and `registerMiddleware` cannot be tricked into writing
 * outside `root` via a symlinked `reamrc.ts` or `start/kernel.ts`.
 */
function assertCanonicallyInside(root: string, filePath: string, displayName: string): void {
  if (!fs.existsSync(filePath)) return
  const canonRoot = fs.realpathSync(root)
  const canonFile = fs.realpathSync(filePath)
  if (!canonFile.startsWith(canonRoot + path.sep) && canonFile !== canonRoot) {
    throw new Error(
      `[configure] Symlink escape detected: ${displayName} resolves outside project root`,
    )
  }
}

export function createCodemods(options?: { force?: boolean; cwd?: string }): Codemods {
  const force = options?.force ?? false
  const root = path.resolve(options?.cwd ?? process.cwd())

  /**
   * The one place a file reaches the disk.
   *
   * Shared by `writeFile` and `makeUsingStub` rather than copied, because what
   * it does is not writing — it is refusing to write outside the project, to
   * follow a symlink out of it, or over something that already exists.
   */
  async function writeGuarded(
    filePath: string,
    content: string,
    shouldOverwrite: boolean,
  ): Promise<void> {
    if (path.isAbsolute(filePath)) {
      throw new Error(`[configure] Absolute paths not allowed: ${filePath}`)
    }
    const resolved = path.resolve(root, filePath)
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      throw new Error(`[configure] Refusing to write outside project root: ${filePath}`)
    }

    const shouldForce = shouldOverwrite
    if (fs.existsSync(resolved) && !shouldForce) return

    const dir = path.dirname(resolved)
    fs.mkdirSync(dir, { recursive: true })

    const canonRoot = fs.realpathSync(root)

    if (fs.existsSync(dir)) {
      const canonDir = fs.realpathSync(dir)
      if (!canonDir.startsWith(canonRoot + path.sep) && canonDir !== canonRoot) {
        throw new Error(
          `[configure] Symlink escape detected: ${filePath} — directory resolves outside project root`,
        )
      }
    }

    if (fs.existsSync(resolved)) {
      const canonFile = fs.realpathSync(resolved)
      if (!canonFile.startsWith(canonRoot + path.sep)) {
        throw new Error(
          `[configure] Symlink escape detected: ${filePath} — file resolves outside project root`,
        )
      }
    }

    fs.writeFileSync(resolved, content)
  }

  return {
    /**
     * Insert a provider import into `reamrc.ts` by string manipulation.
     *
     * KNOWN LIMITATION: this is a regex-based codemod, not a TS AST
     * transform. It works for the canonical `providers: [ ... ]` shape
     * emitted by `ream new` and tolerates comments/whitespace around
     * the array literal. It does NOT handle unusual shapes such as
     * providers declared via a spread, a ternary, a `const providers =
     * [...]` extracted above the config object, or a `providers:`
     * identifier that appears inside a string literal or block comment
     * elsewhere in the file. For those cases, edit `reamrc.ts` by hand.
     * A full AST-based rewrite is tracked separately.
     */
    async addProvider(importPath: string): Promise<void> {
      const rcPath = path.join(root, 'reamrc.ts')
      if (!fs.existsSync(rcPath)) {
        throw new Error(
          `[configure] reamrc.ts not found — cannot register provider ${importPath}. Run 'ream new' first.`,
        )
      }
      // Same symlink-containment guard registerCommand/registerMiddleware/
      // writeFile apply — a symlinked reamrc.ts must not redirect the
      // write outside the project root.
      assertCanonicallyInside(root, rcPath, 'reamrc.ts')

      let content = fs.readFileSync(rcPath, 'utf8')
      // Dedup check — any mention of the exact import path is treated
      // as an existing registration. This is a coarse heuristic but
      // safe because `importPath` is typically a package path like
      // `@c9up/atlas/providers`, which should not appear in comments
      // or unrelated strings in a typical `reamrc.ts`.
      if (content.includes(`'${importPath}'`) || content.includes(`"${importPath}"`)) return

      const entry = `    () => import('${importPath}'),`
      // Marker tolerates extra whitespace and optional trailing comments
      // between `providers:` and `[`. Still brittle to string-literal
      // false-positives (see doc above).
      const marker = /providers\s*:\s*(?:\/\*[\s\S]*?\*\/\s*)?\[/
      const match = marker.exec(content)
      if (!match) {
        throw new Error(
          `[configure] Could not find 'providers: [' in reamrc.ts — provider ${importPath} not added. Check your reamrc.ts format.`,
        )
      }
      const insertAt = match.index + match[0].length
      const eol = detectLineEnding(content)
      content = `${content.slice(0, insertAt)}${eol}${entry}${content.slice(insertAt)}`
      fs.writeFileSync(rcPath, content)
    },

    /**
     * Record a non-module file the application owns.
     *
     * A package calls this from `configure()` so its files reach the build:
     * `addMetaFile('resources/lang/**\/*.json', false)`. The second argument
     * is DELIBERATELY explicit at every call site — whether an edit costs a
     * development restart is the decision the entry exists to record.
     *
     * Same regex codemod as `addProvider`, and the same limits: a `metaFiles`
     * assembled by a spread or extracted into a `const` above the config is not
     * rewritten. The block is created when absent, which `addProvider` cannot
     * do — `providers` is always there, `metaFiles` usually is not.
     */
    async addMetaFile(pattern: string, reloadServer = false): Promise<void> {
      const rcPath = path.join(root, 'reamrc.ts')
      if (!fs.existsSync(rcPath)) {
        throw new Error(
          `[configure] reamrc.ts not found — cannot register meta file ${pattern}. Run 'ream new' first.`,
        )
      }
      assertCanonicallyInside(root, rcPath, 'reamrc.ts')

      let content = fs.readFileSync(rcPath, 'utf8')
      // Dedup on the PATTERN alone: the same glob registered twice with
      // different flags is a contradiction, and the first one wins rather than
      // both being written.
      if (content.includes(`'${pattern}'`) || content.includes(`"${pattern}"`)) return

      const eol = detectLineEnding(content)
      const entry = `    { pattern: '${pattern}', reloadServer: ${reloadServer} },`

      const existing = /metaFiles\s*:\s*(?:\/\*[\s\S]*?\*\/\s*)?\[/.exec(content)
      if (existing !== null) {
        const insertAt = existing.index + existing[0].length
        content = `${content.slice(0, insertAt)}${eol}${entry}${content.slice(insertAt)}`
        fs.writeFileSync(rcPath, content)
        return
      }

      // No block yet — open one beside `providers`, which every rc file has.
      const providers = /providers\s*:\s*(?:\/\*[\s\S]*?\*\/\s*)?\[/.exec(content)
      if (providers === null) {
        throw new Error(
          `[configure] Could not find 'providers: [' in reamrc.ts — meta file ${pattern} not added. Check your reamrc.ts format.`,
        )
      }
      const blockAt = providers.index
      const block = `metaFiles: [${eol}${entry}${eol}  ],${eol}  `
      content = `${content.slice(0, blockAt)}${block}${content.slice(blockAt)}`
      fs.writeFileSync(rcPath, content)
    },

    async addEnvVars(vars: Record<string, string>): Promise<void> {
      const envPath = path.join(root, '.env')
      // A symlinked .env must not redirect the write outside the root.
      assertCanonicallyInside(root, envPath, '.env')
      let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
      let added = 0

      for (const [key, value] of Object.entries(vars)) {
        const pattern = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=`, 'm')
        if (!pattern.test(content)) {
          content += `${key}=${value}\n`
          added++
        }
      }

      if (added > 0) fs.writeFileSync(envPath, content)
    },

    async writeFile(filePath: string, content: string, opts?: { force?: boolean }): Promise<void> {
      return writeGuarded(filePath, content, opts?.force ?? force)
    },

    /**
     * Render a stub and write it where the stub says.
     *
     * The application's own copy wins: a stub published to `stubs/<stubPath>`
     * is used instead of the package's, which is what lets someone change the
     * config a package generates without forking it. Adonis calls the same
     * thing "searches in publishTarget first"; `ream-cli` already does it for
     * the `make:` generators, and this is the same rule on the configure side.
     *
     * A package therefore names its stub after itself — `config/visa.stub`,
     * not `config.stub` — or two packages would publish to the same path.
     */
    async makeUsingStub(
      stubsRoot: string,
      stubPath: string,
      state: StubState = {},
      opts?: { force?: boolean },
    ): Promise<GeneratedStub> {
      if (stubPath.includes('..') || path.isAbsolute(stubPath)) {
        throw new Error(`[configure] Unsafe stub path: ${stubPath}`)
      }

      const published = path.resolve(root, 'stubs', stubPath)
      const shipped = path.resolve(stubsRoot, stubPath)
      const source = fs.existsSync(published) ? published : shipped
      if (!fs.existsSync(source)) {
        throw new Error(`[configure] Stub not found: ${stubPath} (looked in ${stubsRoot})`)
      }

      const raw = fs.readFileSync(source, 'utf8')
      const { to, body } = splitFrontMatter(raw)
      if (to === undefined) {
        // Without it there is nowhere to put the file, and guessing from the
        // stub's own name would put a package's config wherever it was named.
        throw new Error(
          `[configure] Stub ${stubPath} declares no destination — add a \`to:\` front matter line.`,
        )
      }

      // The destination goes through the engine too: `to: config/{{ name }}.ts`
      // is the reason a single stub can serve several outputs.
      const destination = renderTemplate(to, state)
      const contents = renderTemplate(body, state)
      await writeGuarded(destination, contents, opts?.force ?? force)
      return { path: destination, contents }
    },

    /**
     * Insert a command import into `reamrc.ts` `commands: [ ... ]` array.
     *
     * Mirrors `addProvider`'s shape: regex-based codemod (NOT a TS AST
     * transform), idempotent string-match dedup against the exact import
     * path quoted, `[configure]` error prefix on failure.
     *
     * Bootstraps the `commands:` field when absent — inserts immediately
     * after the existing `providers: [...]` block when present, otherwise
     * before the closing `})` of `defineConfig({...})`. The field is
     * optional in `ReamrcConfig` (Ignitor.ts:55), so adding it is
     * non-breaking.
     *
     * Indent convention: inserted entries use 4-space indent, matching the
     * canonical depth-2 nesting inside `defineConfig({ providers: [ ... ] })`.
     * (registerMiddleware uses 2-space indent because its target is the
     * depth-1 `<tier>.use([ ... ])` call in `start/kernel.ts`.)
     *
     * Marker anchoring: top-level fields of `defineConfig({...})` are
     * anchored to start-of-line + ≤4 leading spaces to reject false matches
     * inside nested objects (e.g. a `tests: { commands: [...] }` field
     * higher in `reamrc.ts`).
     */
    async registerCommand(importPath: string): Promise<void> {
      const rcPath = path.join(root, 'reamrc.ts')
      if (!fs.existsSync(rcPath)) {
        throw new Error(
          `[configure] reamrc.ts not found — cannot register command ${importPath}. Run 'ream new' first.`,
        )
      }
      assertCanonicallyInside(root, rcPath, 'reamrc.ts')

      let content = fs.readFileSync(rcPath, 'utf8')
      if (content.includes(`'${importPath}'`) || content.includes(`"${importPath}"`)) return

      const eol = detectLineEnding(content)
      const entry = `    () => import('${importPath}'),`

      // Anchor `commands:` to start-of-line + ≤4 leading spaces (top-level field of
      // `defineConfig({...})`). Rejects nested matches like `tests: { commands: [...] }`.
      const arrayMarker = /^[ \t]{0,4}commands\s*:\s*(?:\/\*[\s\S]*?\*\/\s*)?\[/m
      const arrayMatch = arrayMarker.exec(content)
      if (arrayMatch !== null) {
        const insertAt = arrayMatch.index + arrayMatch[0].length
        content = `${content.slice(0, insertAt)}${eol}${entry}${content.slice(insertAt)}`
        fs.writeFileSync(rcPath, content)
        return
      }

      const block = `  commands: [${eol}${entry}${eol}  ],${eol}`

      // Same start-of-line anchor as the commands marker — rejects nested `providers:`.
      // Note: the non-greedy `\[[\s\S]*?\]` still finds the FIRST `]` after `providers:`,
      // so a top-level `providers: [...]` containing nested `]` (e.g. tuple-typed entries)
      // can still mis-match. Rare in practice; if hit, the user's reamrc.ts is in a shape
      // the regex codemod cannot safely manipulate — they should add `commands: []`
      // manually and re-run, or fall through to the defineConfig-close fallback below.
      const providersEndMarker = /^[ \t]{0,4}providers\s*:\s*\[[\s\S]*?\],?[ \t]*\r?\n/m
      const providersEnd = providersEndMarker.exec(content)
      if (providersEnd !== null) {
        const insertAt = providersEnd.index + providersEnd[0].length
        content = `${content.slice(0, insertAt)}${block}${content.slice(insertAt)}`
        fs.writeFileSync(rcPath, content)
        return
      }

      // Use the LAST `})` in the file (conventionally the `defineConfig({...})` close in a
      // canonical `export default defineConfig({...})` reamrc). `lastIndexOf` avoids the
      // /m-anchored `exec` returning the FIRST line ending in `})` — which would mis-target
      // a helper above defineConfig like `const helper = makeProviders({ eager: true })`.
      const defineCloseIdx = content.lastIndexOf('})')
      if (defineCloseIdx !== -1) {
        content = `${content.slice(0, defineCloseIdx)}${block}${content.slice(defineCloseIdx)}`
        fs.writeFileSync(rcPath, content)
        return
      }

      throw new Error(
        `[configure] Could not find 'defineConfig({ ... })' in reamrc.ts — command ${importPath} not added. Check your reamrc.ts format.`,
      )
    },

    /**
     * Insert a middleware import into `start/kernel.ts` `<tier>.use([ ... ])`
     * array. `tier` defaults to `'router'` (matched routes only) — the
     * conservative choice that does not run on 404s. Set `tier: 'server'`
     * for middleware that must run on every request including 404s
     * (security headers, request-id, structured logging).
     *
     * Mirrors `addProvider`'s shape: regex-based codemod, idempotent
     * per-tier string-match dedup, `[configure]` error prefix.
     *
     * KNOWN LIMITATION: does NOT bootstrap a missing `<tier>.use([])`
     * block. Unlike `commands`, the `server.use` / `router.use` calls
     * are user-authored idiom in `start/kernel.ts`, not a config-shape
     * contract — synthesising them would require also synthesising the
     * `import server from '@c9up/ream/services/server'` boilerplate, and
     * is footgun-prone if the user has renamed identifiers. When the
     * targeted block is absent, this method errors and asks the user
     * to add the block manually.
     *
     * Cross-tier collision is rejected: registering the same import path
     * in BOTH `server` and `router` tiers is almost certainly a mistake;
     * the second call throws `[configure] middleware <importPath> is
     * already registered in <other-tier> tier`.
     *
     * Indent convention: inserted entries use 2-space indent, matching
     * the canonical depth-1 nesting inside `<tier>.use([ ... ])` at the
     * top of `start/kernel.ts`. (registerCommand uses 4-space indent
     * because its target is the depth-2 `defineConfig({ commands: [ ... ] })`
     * block in `reamrc.ts`.)
     */
    async registerMiddleware(
      importPath: string,
      options?: { tier?: MiddlewareTier },
    ): Promise<void> {
      const requestedTier = options?.tier ?? 'router'
      if (!isMiddlewareTier(requestedTier)) {
        throw new Error(
          `[configure] Invalid middleware tier: '${String(requestedTier)}'. Expected 'server' or 'router'.`,
        )
      }

      const tier: MiddlewareTier = requestedTier
      const otherTier: MiddlewareTier = tier === 'server' ? 'router' : 'server'

      const kernelPath = path.join(root, 'start', 'kernel.ts')
      if (!fs.existsSync(kernelPath)) {
        throw new Error(
          `[configure] start/kernel.ts not found — cannot register middleware ${importPath}. Run 'ream new' first or create the file from the installation guide.`,
        )
      }
      assertCanonicallyInside(root, kernelPath, 'start/kernel.ts')

      let content = fs.readFileSync(kernelPath, 'utf8')

      const otherBlock = findTierBlock(content, otherTier)
      if (otherBlock !== null) {
        const otherSlice = content.slice(otherBlock.start, otherBlock.end)
        if (otherSlice.includes(`'${importPath}'`) || otherSlice.includes(`"${importPath}"`)) {
          throw new Error(
            `[configure] middleware ${importPath} is already registered in ${otherTier} tier — cannot also register in ${tier} tier. Choose one tier or remove the existing registration.`,
          )
        }
      }

      const targetBlock = findTierBlock(content, tier)
      if (targetBlock === null) {
        throw new Error(
          `[configure] Could not find '${tier}.use([' in start/kernel.ts — middleware ${importPath} not added. Add the block manually or check your start/kernel.ts format.`,
        )
      }

      const targetSlice = content.slice(targetBlock.start, targetBlock.end)
      if (targetSlice.includes(`'${importPath}'`) || targetSlice.includes(`"${importPath}"`)) {
        return
      }

      const eol = detectLineEnding(content)
      const entry = `  () => import('${importPath}'),`
      content = `${content.slice(0, targetBlock.start)}${eol}${entry}${content.slice(targetBlock.start)}`
      fs.writeFileSync(kernelPath, content)
    },
  }
}
