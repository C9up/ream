import { describe, expect, it } from 'vitest'
import { ConfigStore } from '../../src/ConfigLoader.js'

describe('ConfigStore > dot-notation (AdonisJS parity)', () => {
  it('reads nested values with dot-notation', () => {
    const config = new ConfigStore()
    config.loadFromObject({ database: { mysql: { host: '127.0.0.1', port: 3306 } } })
    expect(config.get('database.mysql.host')).toBe('127.0.0.1')
    expect(config.get('database.mysql.port')).toBe(3306)
    expect(config.get('database.mysql')).toEqual({ host: '127.0.0.1', port: 3306 })
  })

  it('returns a whole top-level module (backward-compatible single-segment key)', () => {
    const config = new ConfigStore()
    config.loadFromObject({ static: { publicPath: '/public' } })
    expect(config.get('static')).toEqual({ publicPath: '/public' })
  })

  it('returns the default when the path is absent', () => {
    const config = new ConfigStore()
    config.loadFromObject({ app: { key: 'x' } })
    expect(config.get('app.missing', 'fallback')).toBe('fallback')
    expect(config.get('nope.at.all')).toBeUndefined()
  })

  it('sets nested values by dot-notation, creating intermediate objects', () => {
    const config = new ConfigStore()
    config.set('database.pg.host', 'localhost')
    expect(config.get('database.pg.host')).toBe('localhost')
  })

  it('has() checks nested existence', () => {
    const config = new ConfigStore()
    config.loadFromObject({ mail: { smtp: { port: 587 } } })
    expect(config.has('mail.smtp.port')).toBe(true)
    expect(config.has('mail.smtp.secure')).toBe(false)
  })

  it('all() returns the full tree', () => {
    const config = new ConfigStore()
    config.loadFromObject({ a: 1, b: { c: 2 } })
    expect(config.all()).toEqual({ a: 1, b: { c: 2 } })
  })

  it('defaults() fills gaps but lets existing config win', () => {
    const config = new ConfigStore()
    config.loadFromObject({ session: { cookieName: 'custom' } })
    config.defaults('session', { cookieName: 'default', maxAge: 3600 })
    expect(config.get('session')).toEqual({ cookieName: 'custom', maxAge: 3600 })
  })

  it('defaults() sets the value verbatim when the key is absent', () => {
    const config = new ConfigStore()
    config.defaults('cors', { origin: '*' })
    expect(config.get('cors')).toEqual({ origin: '*' })
  })
})
