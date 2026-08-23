/**
 * Aliases were dereferenced by recursing into `resolve()` BEFORE the cycle
 * guard was armed, so a two-alias loop overflowed the stack instead of naming
 * the cycle — a stack trace with no clue which aliases were involved.
 */
import { describe, expect, it } from 'vitest'
import { Container } from '../../src/container/Container.js'

describe('ream > alias cycles', () => {
  it('names the cycle instead of overflowing the stack', async () => {
    const container = new Container()
    container.alias('a', 'b')
    container.alias('b', 'a')
    await expect(container.resolve('a')).rejects.toThrow(/Circular alias/)
  })

  it('names a longer cycle too', async () => {
    const container = new Container()
    container.alias('a', 'b')
    container.alias('b', 'c')
    container.alias('c', 'a')
    await expect(container.resolve('a')).rejects.toThrow(/Circular alias/)
  })

  it('still follows a chain that ends at a binding', async () => {
    const container = new Container()
    container.singleton('real', async () => ({ ok: true }))
    container.alias('first', 'second')
    container.alias('second', 'real')
    expect(await container.resolve('first')).toEqual({ ok: true })
  })
})
