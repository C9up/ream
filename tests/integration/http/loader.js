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
  return require(join(__dirname, `index.${suffix}.node`))
}

const native = loadNativeModule()

export const HyperServer = native.HyperServer
