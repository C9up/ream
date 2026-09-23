/**
 * `@c9up/ream/stubs` — the stub engine, and where this package keeps its own.
 *
 * Every Ream package exports a `stubsRoot` from this subpath: it is what
 * `codemods.makeUsingStub(stubsRoot, 'make/controller.stub')` takes, and what
 * `ream eject --pkg` reads to copy a template into the application.
 */

import * as path from 'node:path'

export * from './template.js'

/** `<package>/stubs` — resolved from this file, so it survives the build. */
export const stubsRoot = path.join(import.meta.dirname, '..', '..', 'stubs')
