import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { platform, arch } from 'node:process'

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
  const binaryPath = join(__dirname, `index.${suffix}.node`)
  return require(binaryPath)
}

const native = loadNativeModule()

export const hello = native.hello
export const add = native.add
export const throwReamError = native.throwReamError
export const triggerPanic = native.triggerPanic
export const noop = native.noop
