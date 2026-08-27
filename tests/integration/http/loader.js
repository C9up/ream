import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { arch, platform } from 'node:process'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))

function loadNativeModule() {
  const platformMap = {
    'linux-x64': 'linux-x64-gnu',
    'darwin-x64': 'darwin-x64',
    'darwin-arm64': 'darwin-arm64',
    'win32-x64': 'win32-x64-msvc',
    'linux-arm64': 'linux-arm64-gnu',
  }
  const key = `${platform}-${arch}`
  const suffix = platformMap[key]
  if (!suffix) {
    throw new Error(`Unsupported platform: ${key}`)
  }
  // The binary the package SHIPS, not a hand-copied one next to the test.
  // A local copy is gitignored and refreshed by nothing, so it drifts from the
  // Rust source silently — an integration test then passes against a build
  // that no longer matches the code it is meant to cover.
  return require(join(__dirname, '..', '..', '..', `index.${suffix}.node`))
}

const native = loadNativeModule()

export const HyperServer = native.HyperServer
