/**
 * Hash — multi-driver password hashing service.
 *
 *   await hash.make('password')
 *   await hash.verify('password', hashed)
 *
 * Drivers: argon2 (Rust NAPI), bcrypt (Rust NAPI), scrypt (Node.js).
 */

import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import {
  argon2Hash, argon2Verify,
  bcryptHash, bcryptVerify,
} from '../security/crypto.js'

const scryptAsync = promisify(scrypt)

export interface HashDriver {
  make(value: string): Promise<string>
  verify(value: string, hash: string): Promise<boolean>
}

export interface HashConfig {
  default: string
  drivers: Record<string, { driver: string; [key: string]: unknown }>
}

class Argon2Driver implements HashDriver {
  async make(value: string): Promise<string> {
    const result = argon2Hash(value)
    if (result !== null) return result
    const salt = randomBytes(32)
    const derived = (await scryptAsync(value, salt, 64)) as Buffer
    return `$scrypt$${salt.toString('hex')}$${derived.toString('hex')}`
  }

  async verify(value: string, hash: string): Promise<boolean> {
    const result = argon2Verify(value, hash)
    if (result !== null) return result
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

class BcryptDriver implements HashDriver {
  private rounds: number
  constructor(config: Record<string, unknown> = {}) {
    this.rounds = (config.rounds as number) ?? 12
  }

  async make(value: string): Promise<string> {
    const result = bcryptHash(value, this.rounds)
    if (result !== null) return result
    throw new Error('Bcrypt requires the Rust NAPI binary')
  }

  async verify(value: string, hash: string): Promise<boolean> {
    const result = bcryptVerify(value, hash)
    if (result !== null) return result
    throw new Error('Bcrypt requires the Rust NAPI binary')
  }
}

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
  argon2: () => new Argon2Driver(),
  bcrypt: (config) => new BcryptDriver(config),
  scrypt: (config) => new ScryptDriver(config),
}

export class Hash {
  private drivers: Map<string, HashDriver> = new Map()
  private defaultDriver: string

  constructor(config: HashConfig) {
    this.defaultDriver = config.default
    for (const [name, driverConfig] of Object.entries(config.drivers)) {
      const factory = driverFactories[driverConfig.driver]
      if (factory) this.drivers.set(name, factory(driverConfig))
    }
  }

  async make(value: string): Promise<string> { return this.use().make(value) }
  async verify(value: string, hash: string): Promise<boolean> { return this.use().verify(value, hash) }

  use(name?: string): HashDriver {
    const n = name ?? this.defaultDriver
    const driver = this.drivers.get(n)
    if (!driver) throw new Error(`Hash driver '${n}' not configured`)
    return driver
  }
}
