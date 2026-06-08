import { describe, expect, it } from 'vitest'
import { parseSize } from '../../src/bodyparser/parseSize.js'

describe('ream > parseSize', () => {
  it('parses bare numbers as bytes', () => {
    expect(parseSize('1024')).toBe(1024)
    expect(parseSize('0')).toBe(0)
  })

  it('parses kilobytes', () => {
    expect(parseSize('1kb')).toBe(1024)
    expect(parseSize('512KB')).toBe(512 * 1024)
  })

  it('parses megabytes', () => {
    expect(parseSize('1mb')).toBe(1024 * 1024)
    expect(parseSize('5MB')).toBe(5 * 1024 * 1024)
  })

  it('parses gigabytes', () => {
    expect(parseSize('1gb')).toBe(1024 * 1024 * 1024)
    expect(parseSize('2GB')).toBe(2 * 1024 * 1024 * 1024)
  })

  it('falls back to 1mb default on malformed input', () => {
    expect(parseSize('garbage')).toBe(1024 * 1024)
    expect(parseSize('100tb')).toBe(1024 * 1024) // unsupported suffix
    expect(parseSize('')).toBe(1024 * 1024)
  })
})
