import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const docPath = path.resolve(here, '../../../../docs/en/guide/plugin-system.md')
const docPathFr = path.resolve(here, '../../../../docs/fr/guide/plugin-system.md')
const reamSrc = path.resolve(here, '../../src/index.ts')
const codemodsSrcPath = path.resolve(here, '../../src/Codemods.ts')
const roverSrc = path.resolve(here, '../../../rover/src/index.ts')

interface DocBlock {
  readonly title: string
  readonly code: string
  readonly index: number
}

function extractTitledTypescriptBlocks(md: string): DocBlock[] {
  const re = /```typescript title="([^"]+)"\r?\n([\s\S]*?)\r?\n```/g
  const out: DocBlock[] = []
  let m: RegExpExecArray | null = re.exec(md)
  let i = 0
  while (m !== null) {
    out.push({ title: m[1] ?? '', code: m[2] ?? '', index: i })
    i += 1
    m = re.exec(md)
  }
  return out
}

function compileBlocks(blocks: DocBlock[]): readonly ts.Diagnostic[] {
  const virtualRoot = path.resolve(here, '__doc_virtual__')
  const virtualFiles = new Map<string, string>()
  for (const b of blocks) {
    const safe = b.title.replace(/[/\\]/g, '_')
    virtualFiles.set(path.join(virtualRoot, `${b.index}_${safe}`), b.code)
  }

  const opts: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
    resolveJsonModule: true,
    isolatedModules: true,
    types: ['node'],
    allowImportingTsExtensions: false,
  }

  const host = ts.createCompilerHost(opts)
  const origGetSourceFile = host.getSourceFile.bind(host)
  const origReadFile = host.readFile.bind(host)
  const origFileExists = host.fileExists.bind(host)

  host.fileExists = (file: string): boolean => {
    if (virtualFiles.has(file)) return true
    return origFileExists(file)
  }
  host.readFile = (file: string): string | undefined => {
    const v = virtualFiles.get(file)
    if (v !== undefined) return v
    return origReadFile(file)
  }
  host.getSourceFile = (file, lang, onError, shouldCreate) => {
    const v = virtualFiles.get(file)
    if (v !== undefined) {
      return ts.createSourceFile(file, v, lang, true)
    }
    return origGetSourceFile(file, lang, onError, shouldCreate)
  }

  const aliasMap = new Map<string, string>([
    ['@c9up/ream', reamSrc],
    ['@c9up/rover', roverSrc],
  ])
  host.resolveModuleNameLiterals = (literals, containingFile) => {
    return literals.map((lit) => {
      const aliased = aliasMap.get(lit.text)
      if (aliased !== undefined) {
        return {
          resolvedModule: {
            resolvedFileName: aliased,
            extension: ts.Extension.Ts,
            isExternalLibraryImport: false,
          },
        }
      }
      const fallback = ts.resolveModuleName(lit.text, containingFile, opts, host)
      return { resolvedModule: fallback.resolvedModule }
    })
  }

  const program = ts.createProgram({
    rootNames: [...virtualFiles.keys()],
    options: opts,
    host,
  })

  const all = ts.getPreEmitDiagnostics(program)
  return all.filter((d) => d.category === ts.DiagnosticCategory.Error)
}

function formatDiagnostic(d: ts.Diagnostic): string {
  const file = d.file?.fileName ?? '<unknown>'
  const pos = d.start ?? 0
  const lc = d.file ? d.file.getLineAndCharacterOfPosition(pos) : { line: 0, character: 0 }
  const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n')
  return `${file}:${lc.line + 1}:${lc.character + 1} — ${msg}`
}

describe('plugin-system docs — code blocks typecheck against live package interfaces', () => {
  const md = readFileSync(docPath, 'utf8')
  const blocks = extractTitledTypescriptBlocks(md)

  it('extracts the three runnable typescript blocks (signature, postmark configure, postmark index)', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(3)
    const titles = blocks.map((b) => b.title)
    expect(titles).toContain('src/configure.ts')
    expect(titles).toContain('src/index.ts')
  })

  it('all titled typescript blocks compile clean against live Codemods + Rover types', () => {
    const errors = compileBlocks(blocks)
    if (errors.length > 0) {
      const formatted = errors.map(formatDiagnostic).join('\n')
      throw new Error(`Doc code blocks failed to typecheck:\n${formatted}`)
    }
    expect(errors).toEqual([])
  })

  it('configure() signature uses Codemods + flags?: Record<string, string[]> + Promise<void>', () => {
    const signatureBlock = blocks.find(
      (b) => b.title === 'src/configure.ts' && b.code.includes('// ...'),
    )
    expect(signatureBlock, 'expected a signature-style configure.ts block').toBeDefined()
    const code = signatureBlock?.code ?? ''
    expect(code).toMatch(/codemods:\s*Codemods/)
    expect(code).toMatch(/flags\?:\s*Record<string,\s*string\[\]>/)
    expect(code).toMatch(/Promise<void>/)
  })

  it('worked-example configure() invokes only methods that exist on the live Codemods interface', () => {
    const exampleBlock = blocks.find(
      (b) => b.title === 'src/configure.ts' && b.code.includes('SNIPPET'),
    )
    expect(exampleBlock, 'expected a Postmark worked-example configure.ts block').toBeDefined()
    const code = exampleBlock?.code ?? ''

    const invocationRe = /codemods\.([a-zA-Z_$][\w$]*)\s*\(/g
    const invoked = new Set<string>()
    let m: RegExpExecArray | null = invocationRe.exec(code)
    while (m !== null) {
      if (m[1] !== undefined) invoked.add(m[1])
      m = invocationRe.exec(code)
    }
    expect(invoked.size).toBeGreaterThan(0)

    const codemodsSrc = readFileSync(codemodsSrcPath, 'utf8')
    const liveMethods = new Set([
      'addProvider',
      'addEnvVars',
      'writeFile',
      'registerCommand',
      'registerMiddleware',
    ])
    for (const name of liveMethods) {
      expect(
        codemodsSrc,
        `expected method '${name}' to be defined in Codemods.ts — a rename or removal would silently invalidate the doc-shape gate`,
      ).toMatch(new RegExp(`^\\s*(?:async\\s+)?${name}\\s*\\(`, 'm'))
    }
    for (const name of invoked) {
      expect(
        liveMethods.has(name),
        `codemods.${name}() invoked in docs but not on live Codemods interface`,
      ).toBe(true)
    }
  })

  it('every Codemods.ts:NN cite in plugin-system.md (EN+FR) resolves to the expected symbol on that line', () => {
    const codemodsSrcLines = readFileSync(codemodsSrcPath, 'utf8').split(/\r?\n/)
    const symbolMap = new Map<number, RegExp>([
      [4, /interface Codemods\b/],
      [76, /KNOWN LIMITATION/],
      [86, /async addProvider\b/],
      [123, /async addEnvVars\b/],
      [141, /async writeFile\b/],
      [202, /async registerCommand\b/],
      [291, /async registerMiddleware\b/],
    ])

    // Cites whose target line text is generic (e.g. a JSDoc fragment) need a context sniff so
    // the regex doesn't pass on a coincidental match outside the intended symbol's scope.
    // `before`/`after` define the window (in lines) around the cited line that must mention `mustMatch`.
    const symbolContextMap = new Map<number, { before: number; after: number; mustMatch: RegExp }>([
      [76, { before: 5, after: 15, mustMatch: /addProvider/ }],
    ])

    const citeRe = /Codemods\.ts:(\d+(?:,\s*\d+)*)/g

    for (const lang of ['en', 'fr'] as const) {
      const sourceMd =
        lang === 'en' ? readFileSync(docPath, 'utf8') : readFileSync(docPathFr, 'utf8')
      const symbolHits: number[] = []
      let setHit: number[] | null = null
      let m: RegExpExecArray | null = citeRe.exec(sourceMd)
      while (m !== null) {
        const raw = m[1] ?? ''
        const nums = raw.split(/\s*,\s*/).map((s) => Number.parseInt(s, 10))
        if (nums.length === 1) {
          const first = nums[0]
          if (typeof first === 'number') symbolHits.push(first)
        } else {
          expect(setHit, `unexpected second comma-list cite in ${lang} plugin-system.md`).toBeNull()
          setHit = nums
        }
        m = citeRe.exec(sourceMd)
      }

      expect(symbolHits.length, `${lang}: expected at least one single-line cite`).toBeGreaterThan(
        0,
      )

      for (const lineNo of symbolHits) {
        const expected = symbolMap.get(lineNo)
        expect(expected, `${lang}: Codemods.ts:${lineNo} not in expected symbol map`).toBeDefined()
        const live = codemodsSrcLines[lineNo - 1] ?? ''
        if (expected !== undefined && !expected.test(live)) {
          const hint = (() => {
            for (let i = 0; i < codemodsSrcLines.length; i += 1) {
              if (expected.test(codemodsSrcLines[i] ?? '')) return i + 1
            }
            return -1
          })()
          throw new Error(
            `plugin-system.md (${lang}) cites Codemods.ts:${lineNo} → expected /${expected.source}/ on line ${lineNo}, found ${JSON.stringify(live)}.${hint > 0 ? ` Symbol moved to line ${hint} — update the cite.` : ' Symbol not found anywhere — verify the source.'}`,
          )
        }

        const ctx = symbolContextMap.get(lineNo)
        if (ctx !== undefined) {
          const start = Math.max(0, lineNo - 1 - ctx.before)
          const stop = Math.min(codemodsSrcLines.length, lineNo + ctx.after)
          const window = codemodsSrcLines.slice(start, stop).join('\n')
          if (!ctx.mustMatch.test(window)) {
            throw new Error(
              `plugin-system.md (${lang}) cites Codemods.ts:${lineNo} → line matches /${expected?.source ?? ''}/ but the surrounding ${ctx.before}+${ctx.after} lines do not mention /${ctx.mustMatch.source}/ — cite may have drifted to a coincidental match outside the intended symbol's scope.`,
            )
          }
        }
      }

      expect(setHit, `${lang}: expected the 12-entry [configure] cite SET`).not.toBeNull()
      if (setHit !== null) {
        expect(setHit.length, `${lang}: [configure] cite SET should have 12 entries`).toBe(12)
        for (const lineNo of setHit) {
          const live = codemodsSrcLines[lineNo - 1] ?? ''
          expect(
            live,
            `${lang}: Codemods.ts:${lineNo} cited in [configure] SET but line lacks '[configure]' substring`,
          ).toContain('[configure]')
        }
      }
    }
  })
})
