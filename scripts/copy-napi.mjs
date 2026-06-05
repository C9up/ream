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
import { arch, platform } from 'node:process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const SUFFIX_MAP = {
  'linux-x64': 'linux-x64-gnu',
  'linux-arm64': 'linux-arm64-gnu',
  'darwin-x64': 'darwin-x64',
  'darwin-arm64': 'darwin-arm64',
  'win32-x64': 'win32-x64-msvc',
}

const suffix = SUFFIX_MAP[`${platform}-${arch}`]
if (!suffix) {
  throw new Error(`[ream:napi] unsupported platform/arch: ${platform}-${arch}`)
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
  if (platform === 'win32') {
    return [
      join(root, 'target', 'release', `${crateLib}.dll`),
      join(root, 'target', 'release', `lib${crateLib}.dll`),
    ]
  }
  if (platform === 'darwin') {
    return [join(root, 'target', 'release', `lib${crateLib}.dylib`)]
  }
  return [join(root, 'target', 'release', `lib${crateLib}.so`)]
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
