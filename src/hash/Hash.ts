/**
 * Hash — multi-driver password hashing service.
 *
 * Like AdonisJS Hash:
 *   hash.make('password')
 *   hash.verify('password', hashed)
 *
 * Drivers: argon2 (Rust NAPI), bcrypt (Rust NAPI), scrypt (Node.js crypto).
 * Configured via config/hash.ts.
 */

import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt)

export interface HashDriver {
  make(value: string): Promise<string>
  verify(value: string, hash: string): Promise<boolean>
}

export interface HashConfig {
  default: string
  drivers: Record<string, { driver: string; [key: string]: unknown }>
}

/**
 * Argon2 driver — uses Rust NAPI when available, falls back to Node.js.
 */
class Argon2Driver implements HashDriver {
  private napi?: { argon2Hash: (p: string) => string; argon2Verify: (p: string, h: string) => boolean }

  constructor(private config: Record<string, unknown> = {}) {
    try {
      this.napi = globalThis.__reamSecurityNapi
    } catch { /* NAPI not available */ }
  }

  async make(value: string): Promise<string> {
    if (this.napi) return this.napi.argon2Hash(value)
    // Fallback: Node.js scrypt-based (not real argon2, but functional)
    const salt = randomBytes(32)
    const derived = (await scryptAsync(value, salt, 64)) as Buffer
    return `$scrypt$${salt.toString('hex')}$${derived.toString('hex')}`
  }

  async verify(value: string, hash: string): Promise<boolean> {
    if (this.napi) return this.napi.argon2Verify(value, hash)
    if (hash.startsWith('$scrypt$')) {
      const [, , saltHex, keyHex] = hash.split('$')
      const salt = Buffer.from(saltHex, 'hex')
      const storedKey = Buffer.from(keyHex, 'hex')
      const derived = (await scryptAsync(value, salt, 64)) as Buffer
      return derived.length === storedKey.length && timingSafeEqual(derived, storedKey)
    }
    return false
  }
}

/**
 * Bcrypt driver — uses Rust NAPI.
 */
class BcryptDriver implements HashDriver {
  private rounds: number
  private napi?: { bcryptHash: (p: string, r?: number) => string; bcryptVerify: (p: string, h: string) => boolean }

  constructor(config: Record<string, unknown> = {}) {
    this.rounds = (config.rounds as number) ?? 12
    try {
      this.napi = globalThis.__reamSecurityNapi
    } catch { /* NAPI not available */ }
  }

  async make(value: string): Promise<string> {
    if (this.napi) return this.napi.bcryptHash(value, this.rounds)
    throw new Error('Bcrypt requires the ream-security NAPI binary. Build with: cargo build -p ream-http-napi')
  }

  async verify(value: string, hash: string): Promise<boolean> {
    if (this.napi) return this.napi.bcryptVerify(value, hash)
    throw new Error('Bcrypt requires the ream-security NAPI binary.')
  }
}

/**
 * Scrypt driver — pure Node.js crypto.
 */
class ScryptDriver implements HashDriver {
  private keyLength: number
  private saltLength: number

  constructor(config: Record<string, unknown> = {}) {
    this.keyLength = (config.keyLength as number) ?? 64
    this.saltLength = (config.saltLength as number) ?? 32
  }

  async make(value: string): Promise<string> {
    const salt = randomBytes(this.saltLength)
    const derived = (await scryptAsync(value, salt, this.keyLength)) as Buffer
    return `${salt.toString('hex')}:${derived.toString('hex')}`
  }

  async verify(value: string, hash: string): Promise<boolean> {
    const [saltHex, keyHex] = hash.split(':')
    if (!saltHex || !keyHex) return false
    const salt = Buffer.from(saltHex, 'hex')
    const storedKey = Buffer.from(keyHex, 'hex')
    const derived = (await scryptAsync(value, salt, this.keyLength)) as Buffer
    if (derived.length !== storedKey.length) return false
    return timingSafeEqual(derived, storedKey)
  }
}

const driverFactories: Record<string, (config: Record<string, unknown>) => HashDriver> = {
  argon2: (config) => new Argon2Driver(config),
  bcrypt: (config) => new BcryptDriver(config),
  scrypt: (config) => new ScryptDriver(config),
}

/**
 * Hash manager — resolves the configured driver and provides make/verify.
 */
export class Hash {
  private drivers: Map<string, HashDriver> = new Map()
  private defaultDriver: string

  constructor(config: HashConfig) {
    this.defaultDriver = config.default

    for (const [name, driverConfig] of Object.entries(config.drivers)) {
      const factory = driverFactories[driverConfig.driver]
      if (factory) {
        this.drivers.set(name, factory(driverConfig))
      }
    }
  }

  /** Hash a value using the default driver. */
  async make(value: string): Promise<string> {
    return this.use().make(value)
  }

  /** Verify a value against a hash using the default driver. */
  async verify(value: string, hash: string): Promise<boolean> {
    return this.use().verify(value, hash)
  }

  /** Get a specific driver by name. */
  use(name?: string): HashDriver {
    const driverName = name ?? this.defaultDriver
    const driver = this.drivers.get(driverName)
    if (!driver) {
      throw new Error(`Hash driver '${driverName}' not configured. Available: ${[...this.drivers.keys()].join(', ')}`)
    }
    return driver
  }
}

// Global reference for NAPI bindings (set by the NAPI loader)
declare global {
  // biome-ignore lint/style/noVar: global declaration requires var
  var __reamSecurityNapi: {
    argon2Hash: (password: string) => string
    argon2Verify: (password: string, hash: string) => boolean
    bcryptHash: (password: string, rounds?: number) => string
    bcryptVerify: (password: string, hash: string) => boolean
  } | undefined
}
