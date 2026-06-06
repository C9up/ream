// Copy every freshly-built Ream NAPI cdylib out of cargo's target
// directory and into the package root with the platform-suffix naming
// convention used by `napi-loader.ts`:
//
//     packages/ream/index.linux-x64-gnu.node       (ream-http-napi)
//     packages/ream/scheduler.linux-x64-gnu.node   (ream-scheduler-napi)
//     packages/ream/index.darwin-arm64.node
//     ...
//
// The TS loader walks two upper directories from each `loadNapi` caller
// to find these files, so the binaries MUST live at the package root
// (not under target/) to be discovered at runtime.
//
// Usage:
//
//     pnpm --filter @c9up/ream build:rust     # cargo build --release
//     pnpm --filter @c9up/ream build:napi     # build:rust + this script
//
// The package.json script chains both steps. CI / npm publish runs
// `build:napi` once per platform during the matrix build — every
// crate listed in `NAPI_CRATES` ships in the tarball.

import { copyFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { arch, env, platform } from 'node:process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

// Rust target triple -> { suffix, os }. Set CARGO_BUILD_TARGET to cross-compile
// (e.g. build the x86_64-apple-darwin binary on an arm64 macOS runner so we
// don't depend on the scarce macos-13 Intel runners). When unset we fall back
// to the host platform/arch and the default target/release dir.
const TRIPLE_MAP = {
  'x86_64-unknown-linux-gnu': { suffix: 'linux-x64-gnu', os: 'linux' },
  'aarch64-unknown-linux-gnu': { suffix: 'linux-arm64-gnu', os: 'linux' },
  'x86_64-apple-darwin': { suffix: 'darwin-x64', os: 'darwin' },
  'aarch64-apple-darwin': { suffix: 'darwin-arm64', os: 'darwin' },
  'x86_64-pc-windows-msvc': { suffix: 'win32-x64-msvc', os: 'win32' },
}

const HOST_SUFFIX_MAP = {
  'linux-x64': 'linux-x64-gnu',
  'linux-arm64': 'linux-arm64-gnu',
  'darwin-x64': 'darwin-x64',
  'darwin-arm64': 'darwin-arm64',
  'win32-x64': 'win32-x64-msvc',
}

const triple = env.CARGO_BUILD_TARGET ?? ''
let suffix
let os
let releaseDir
if (triple) {
  const entry = TRIPLE_MAP[triple]
  if (!entry) {
    throw new Error(`[ream:napi] unsupported CARGO_BUILD_TARGET: ${triple}`)
  }
  suffix = entry.suffix
  os = entry.os
  releaseDir = join(root, 'target', triple, 'release')
} else {
  suffix = HOST_SUFFIX_MAP[`${platform}-${arch}`]
  os = platform
  releaseDir = join(root, 'target', 'release')
  if (!suffix) {
    throw new Error(`[ream:napi] unsupported platform/arch: ${platform}-${arch}`)
  }
}

// Every NAPI crate shipped from the @c9up/ream package. `crateLib` is the
// underscore-suffixed name cargo produces under `target/release/`;
// `targetName` is what `loadNapi({ binaryName })` expects at the package
// root (see `napi-loader.ts` — the binary lookup prefix matches the
// `binaryName` option passed by each TS consumer).
const NAPI_CRATES = [
  { crateLib: 'ream_http_napi', targetName: 'index' },
  { crateLib: 'ream_scheduler_napi', targetName: 'scheduler' },
  { crateLib: 'ream_events_napi', targetName: 'events' },
]

// `crate-type = ["cdylib"]` settles on the platform-conventional file
// name. Linux + macOS prepend `lib`; Windows drops the prefix and uses
// `.dll`. Check both Windows shapes so we degrade gracefully if upstream
// cargo ever switches naming.
function buildCandidates(crateLib) {
  if (os === 'win32') {
    return [
      join(releaseDir, `${crateLib}.dll`),
      join(releaseDir, `lib${crateLib}.dll`),
    ]
  }
  if (os === 'darwin') {
    return [join(releaseDir, `lib${crateLib}.dylib`)]
  }
  return [join(releaseDir, `lib${crateLib}.so`)]
}

for (const { crateLib, targetName } of NAPI_CRATES) {
  const candidates = buildCandidates(crateLib)
  const source = candidates.find((candidate) => existsSync(candidate))
  if (!source) {
    throw new Error(
      `[ream:napi] native library for '${crateLib}' not found. Looked for:\n${candidates
        .map((p) => `- ${p}`)
        .join('\n')}\nRun 'pnpm --filter @c9up/ream build:rust' first.`,
    )
  }
  const target = join(root, `${targetName}.${suffix}.node`)
  copyFileSync(source, target)
  console.log(`[ream:napi] copied ${source} -> ${target}`)
}
