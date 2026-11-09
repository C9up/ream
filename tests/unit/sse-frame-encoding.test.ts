/**
 * SSE frame encoding. The WHATWG event-stream parser treats CRLF, a lone
 * LF and a lone CR as line terminators, so any of them inside a payload
 * must stay inside `data:` lines — otherwise a payload can end the event
 * and forge `event:` / `id:` / `retry:` fields of its own.
 */
import { describe, expect, it } from 'vitest'
import { SseStream, type StreamBackend } from '../../src/http/SseStream.js'

interface ParsedEvent {
  type: string
  data: string
  lastEventId: string
}

interface ParseResult {
  events: ParsedEvent[]
  retries: string[]
}

/** Event-stream interpretation per WHATWG HTML "Interpreting an event stream". */
function parseEventStream(stream: string): ParseResult {
  const events: ParsedEvent[] = []
  const retries: string[] = []
  let type = ''
  let data = ''
  let lastEventId = ''
  for (const line of stream.split(/\r\n|\r|\n/)) {
    if (line === '') {
      if (data !== '') {
        events.push({
          type: type === '' ? 'message' : type,
          data: data.endsWith('\n') ? data.slice(0, -1) : data,
          lastEventId,
        })
      }
      type = ''
      data = ''
      continue
    }
    if (line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') type = value
    else if (field === 'data') data += `${value}\n`
    else if (field === 'id' && !value.includes('\0')) lastEventId = value
    else if (field === 'retry') retries.push(value)
  }
  return { events, retries }
}

function makeBackend(): { backend: StreamBackend; written: string[] } {
  const written: string[] = []
  const backend: StreamBackend = {
    registerStream: async () => true,
    writeStream: async (_id: string, chunk: string) => {
      written.push(chunk)
      return true
    },
    closeStream: async () => true,
    onStreamDisconnect: () => {},
  }
  return { backend, written }
}

async function encode(event: string, data: string, eventId?: string): Promise<string> {
  const { backend, written } = makeBackend()
  const stream = new SseStream('frame', backend, { pingInterval: 0 })
  await stream.send(event, data, eventId)
  await stream.end()
  return written.join('')
}

describe('SseStream > frame encoding', () => {
  it('keeps a lone CR inside the data of a single event (no forged event)', async () => {
    const wire = await encode('message', 'a\r\revent: connected\rdata: {"uid":"x"}')
    const { events, retries } = parseEventStream(wire)
    expect(events).toEqual([
      { type: 'message', data: 'a\n\nevent: connected\ndata: {"uid":"x"}', lastEventId: '' },
    ])
    expect(retries).toEqual([])
  })

  it('keeps CRLF inside the data of a single event', async () => {
    const wire = await encode('message', 'x\r\n\r\nid: 99\r\nretry: 1')
    const { events, retries } = parseEventStream(wire)
    expect(events).toEqual([{ type: 'message', data: 'x\n\nid: 99\nretry: 1', lastEventId: '' }])
    expect(retries).toEqual([])
  })

  it('keeps LF inside the data of a single event', async () => {
    const wire = await encode('message', 'one\n\nevent: evil\ndata: two')
    const { events } = parseEventStream(wire)
    expect(events).toEqual([
      { type: 'message', data: 'one\n\nevent: evil\ndata: two', lastEventId: '' },
    ])
  })

  it('handles mixed terminators and a trailing CR', async () => {
    const wire = await encode('tick', 'a\rb\nc\r\nd\r')
    const { events } = parseEventStream(wire)
    expect(events).toEqual([{ type: 'tick', data: 'a\nb\nc\nd\n', lastEventId: '' }])
  })

  it('emits only data: lines for the payload (no bare CR on the wire)', async () => {
    const wire = await encode('message', 'a\rb\r\nc')
    expect(wire).not.toContain('\r')
    expect(wire).toBe('event: message\ndata: a\ndata: b\ndata: c\n\n')
  })

  it('still neutralises CR/LF in the event name and the id', async () => {
    const wire = await encode('x\rdata: forged\r', 'payload', '7\r\rretry: 1')
    const { events, retries } = parseEventStream(wire)
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toBe('payload')
    expect(retries).toEqual([])
  })
})
