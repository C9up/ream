/**
 * The tsconfigs ream ships have to resolve their paths against the APP that
 * extends them, not against their own location inside `node_modules`.
 *
 * They did not. `outDir: "./dist"` and `exclude: ["node_modules", …]` are
 * relative to the file that declares them, so an app extending
 * `@c9up/ream/tsconfig.app.json` emitted its build into
 * `node_modules/@c9up/ream/dist` — over ream's own — and never excluded its own
 * `node_modules`. `${configDir}` is what TypeScript added for exactly this, and
 * it is what `@adonisjs/tsconfig` uses.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
// Resolved through the `typescript` package itself rather than a path into a
// workspace: this package is also built standalone, where `../../node_modules`
// does not exist.
const tscBin = resolve(dirname(createRequire(import.meta.url).resolve('typescript')), '../bin/tsc')
const dir = mkdtempSync(join(tmpdir(), 'ream-tsconfig-'))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** Resolve a config that extends one of ours, the way a real app would. */
function resolved(which: string): {
  compilerOptions: Record<string, unknown>
  exclude?: string[]
} {
  const file = join(dir, `tsconfig.${which}.json`)
  writeFileSync(file, JSON.stringify({ extends: join(packageRoot, `tsconfig.${which}.json`) }))
  // Both layouts: the app config includes everything, the package config only
  // `src/`, so a fixture missing it fails with "no inputs" rather than an
  // assertion.
  writeFileSync(join(dir, 'index.ts'), 'export const ok = 1\n')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const ok = 1\n')
  const out = execFileSync(tscBin, ['--showConfig', '-p', file], {
    encoding: 'utf8',
  })
  return JSON.parse(out)
}

describe('ream > the shipped tsconfigs', () => {
  it('puts an app build inside the app, not inside ream', () => {
    const { compilerOptions } = resolved('app')

    // Relative to the extending project — never inside node_modules/@c9up/ream.
    expect(String(compilerOptions.outDir)).not.toContain('packages/ream')
    expect(String(compilerOptions.outDir)).not.toContain('node_modules')
  })

  it("excludes the app's own node_modules, not ream's", () => {
    const { exclude } = resolved('app')

    expect(exclude?.some((p) => p.startsWith(dir))).toBe(true)
    expect(exclude?.some((p) => p.includes('packages/ream'))).toBe(false)
  })

  it('keeps the decorator settings an app needs', () => {
    // Inherited from the base: every entity, command and controller uses them.
    const { compilerOptions } = resolved('app')

    expect(compilerOptions.experimentalDecorators).toBe(true)
    expect(compilerOptions.emitDecoratorMetadata).toBe(true)
  })

  it('emits declarations for a package but not for an app', () => {
    expect(resolved('package').compilerOptions.declaration).toBe(true)
    expect(resolved('app').compilerOptions.declaration).toBe(false)
  })

  it('gives client code the DOM and drops the Node types', () => {
    const { compilerOptions } = resolved('client')

    expect(compilerOptions.lib).toContain('dom')
    expect(compilerOptions.types).toEqual([])
  })
})
