/**
 * `session.initiate()` / `session.commit()` — the AdonisJS lifecycle.
 *
 * The store half used to live inside `SessionMiddleware`, so the two names an
 * AdonisJS app knows did not exist, and nothing could drive a session's
 * persistence outside an HTTP request. The rules are unchanged; they moved to
 * where upstream keeps them.
 */

import { describe, expect, it } from 'vitest'
import { MemoryDriver } from '../../src/session/drivers/MemoryDriver.js'
import { Session } from '../../src/session/Session.js'

const TTL = 3600

function seated(driver: MemoryDriver, id = 'sess-1', fresh = false): Session {
  const session = new Session(id)
  session.setStore(driver, { fresh, ttl: TTL })
  return session
}

describe('session > initiate', () => {
  it('loads what the store holds', async () => {
    const driver = new MemoryDriver()
    await driver.write('sess-1', { user: 7 }, TTL)
    const session = seated(driver)

    await session.initiate()

    expect(session.get('user')).toBe(7)
  })

  it('turns the stored flash bag into this request old() values', async () => {
    const driver = new MemoryDriver()
    await driver.write('sess-1', { __flash: { notice: 'Saved' } }, TTL)
    const session = seated(driver)

    await session.initiate()

    expect(session.old('notice')).toBe('Saved')
    // The bag itself is not left in the data.
    expect(session.get('__flash')).toBeUndefined()
  })

  it('is a no-op the second time, as upstream', async () => {
    const driver = new MemoryDriver()
    await driver.write('sess-1', { user: 7 }, TTL)
    const session = seated(driver)
    await session.initiate()
    session.put('user', 9)

    await session.initiate()

    // A second call must not wipe what the request has since written.
    expect(session.get('user')).toBe(9)
  })

  it('does nothing without a store', async () => {
    const session = new Session('sess-1', { user: 1 })
    await expect(session.initiate()).resolves.toBeUndefined()
    expect(session.get('user')).toBe(1)
  })
})

describe('session > commit', () => {
  it('writes a modified session', async () => {
    const driver = new MemoryDriver()
    const session = seated(driver)
    session.put('user', 7)

    await session.commit()

    expect(await driver.read('sess-1')).toMatchObject({ user: 7 })
  })

  it('touches an untouched pre-existing session instead of rewriting it', async () => {
    const driver = new MemoryDriver()
    await driver.write('sess-1', { user: 7 }, 1)
    const session = seated(driver)
    await session.initiate()

    await session.commit()

    // Still there, and its window slid forward rather than the data being
    // written again.
    expect(await driver.read('sess-1')).toMatchObject({ user: 7 })
  })

  it('writes nothing for a brand-new untouched session', async () => {
    // Otherwise every anonymous read-only GET mints a row nobody asked for.
    const driver = new MemoryDriver()
    const session = seated(driver, 'sess-new', true)

    await session.commit()

    expect(await driver.read('sess-new')).toEqual({})
  })

  it('migrates the data to the new id after regenerate(), and drops the old', async () => {
    // Session fixation: the id rotates at a privilege boundary, and the data
    // must follow it — under the NEW id first, so a crash between the two
    // leaves a valid session rather than none.
    const driver = new MemoryDriver()
    await driver.write('old-id', { user: 7 }, TTL)
    const session = seated(driver, 'old-id')
    await session.initiate()

    session.regenerate()
    await session.commit()

    expect(session.sessionId).not.toBe('old-id')
    expect(await driver.read(session.sessionId)).toMatchObject({ user: 7 })
    expect(await driver.read('old-id')).toEqual({})
  })

  it('survives a store that cannot drop the old entry', async () => {
    // The new session is already live; failing the request over a stale row
    // the TTL will reclaim would be worse.
    const driver = new MemoryDriver()
    driver.destroy = async () => {
      throw new Error('store unavailable')
    }
    const session = seated(driver, 'old-id')
    session.regenerate()

    await expect(session.commit()).resolves.toBeUndefined()
    expect(await driver.read(session.sessionId)).toBeTruthy()
  })

  it('does nothing without a store', async () => {
    const session = new Session('sess-1')
    session.put('user', 1)
    await expect(session.commit()).resolves.toBeUndefined()
  })
})
