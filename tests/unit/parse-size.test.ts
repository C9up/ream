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

  it('reads the spellings the bytes grammar allows', () => {
    expect(parseSize('50 mb')).toBe(50 * 1024 * 1024)
    expect(parseSize('1.5mb')).toBe(1.5 * 1024 * 1024)
    expect(parseSize('1tb')).toBe(1024 ** 4)
    expect(parseSize(2048)).toBe(2048)
  })

  it('throws on a size it cannot read instead of falling back to 1mb', () => {
    for (const size of ['garbage', '', 'mb', '-5mb', Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => parseSize(size)).toThrow(/E_BODYPARSER_INVALID_SIZE|Cannot read the size/)
    }
  })
})
