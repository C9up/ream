/**
 * `onFinish` runs the work that must happen but must not delay the reply — a
 * temp file deleted, a metric recorded. `stream` sends a readable as the body.
 */
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { Response as ReamResponse } from '../../src/http/Response.js'

describe('ream > response.onFinish', () => {
  it('runs the callbacks once, in order', () => {
    const order: string[] = []
    const res = new ReamResponse()
    res.onFinish(() => order.push('first'))
    res.onFinish(() => order.push('second'))

    res.runFinishCallbacks()
    expect(order).toEqual(['first', 'second'])

    // Drained: a second pass must not replay them.
    res.runFinishCallbacks()
    expect(order).toEqual(['first', 'second'])
  })

  it('one failing callback does not stop the others', () => {
    const ran = vi.fn()
    const res = new ReamResponse()
    res.onFinish(() => {
      throw new Error('cleanup blew up')
    })
    res.onFinish(ran)
    expect(() => res.runFinishCallbacks()).not.toThrow()
    expect(ran).toHaveBeenCalledTimes(1)
  })
})

describe('ream > response.stream', () => {
  it('sends what the stream produced', async () => {
    const res = new ReamResponse()
    await res.stream(Readable.from(['hello ', 'world']))
    // Binary responses cross the NAPI boundary base64-encoded, the same way
    // `download()` sends a file.
    expect(res.getHeader('x-ream-body-encoding')).toBe('base64')
    expect(Buffer.from(res.getBody(), 'base64').toString()).toBe('hello world')
  })

  it('answers a generic 500 when the stream fails', async () => {
    const res = new ReamResponse()
    await res.stream(
      Readable.from(
        (async function* () {
          yield 'partial'
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        })(),
      ),
    )
    expect(res.getStatus()).toBe(500)
    // The filesystem error is not leaked to the client.
    expect(res.getBody()).not.toContain('EACCES')
  })

  it('lets the caller map the failure', async () => {
    const res = new ReamResponse()
    await res.stream(
      Readable.from(
        (async function* () {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
          // biome-ignore lint/correctness/noUnreachable: the throw is the case under test
          yield ''
        })(),
      ),
      (error) => (error.code === 'ENOENT' ? ['Not found', 404] : ['Oops', 500]),
    )
    expect(res.getStatus()).toBe(404)
    expect(res.getBody()).toBe('Not found')
  })
})
