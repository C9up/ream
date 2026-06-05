import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

/**
 * Round-trip test for the `ream configure` / `ream add` flag pass-through.
 *
 * The Rust CLI encodes flags as `Record<string, string[]>` and embeds the JSON
 * into an inline Node script via the `JSON.parse(<double-encoded-literal>)`
 * pattern. This test exercises ONLY the JS side of that boundary — given a
 * pre-encoded JSON string (mimicking what `serde_json::to_string` produces in
 * Rust), confirm that `JSON.parse` rebuilds the structure identically,
 * including for special characters that frequently corrupt unsafe
 * interpolations: quotes, backslashes, newlines, unicode, regex metas.
 *
 * The full Rust → spawned-Node end-to-end is exercised by the cargo
 * integration tests in `packages/ream-cli/tests/add_test.rs`.
 */
describe('configure flags round-trip (Rust serde_json → JS JSON.parse)', () => {
  function roundTrip(flags: Record<string, string[]>): Record<string, string[]> {
    // Stage 1: encode like serde_json — produces a JSON string of the object.
    const flagsJson = JSON.stringify(flags)
    // Stage 2: double-encode — turns the JSON string into a JS string literal
    // suitable for embedding as `JSON.parse(<literal>)`.
    const flagsLiteral = JSON.stringify(flagsJson)
    // Stage 3: spawn `node -e <script>` with that literal embedded — same
    // shape the Rust CLI uses. Echo the parsed object as JSON to stdout.
    const script = `const FLAGS = JSON.parse(${flagsLiteral}); process.stdout.write(JSON.stringify(FLAGS));`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
    })
    // Surface spawn-level failures (EPERM on noexec /tmp, ENOENT on a
    // missing node, etc.) BEFORE asserting status. Otherwise a sandboxed
    // CI gets `null` status + undefined stdout, and the test reports a
    // confusing `Unexpected end of JSON input` from the parse below
    // instead of the real spawn error.
    if (result.error) {
      throw new Error(
        `spawnSync failed: ${result.error.message} (stderr: ${result.stderr ?? '<none>'})`,
      )
    }
    expect(result.status, `node stderr: ${result.stderr}`).toBe(0)
    return JSON.parse(result.stdout)
  }

  it('survives an empty flag map', () => {
    expect(roundTrip({})).toEqual({})
  })

  it('survives a single flag with one value', () => {
    expect(roundTrip({ transports: ['smtp'] })).toEqual({ transports: ['smtp'] })
  })

  it('survives a flag with multiple values in order', () => {
    expect(roundTrip({ transports: ['smtp', 'resend', 'ses'] })).toEqual({
      transports: ['smtp', 'resend', 'ses'],
    })
  })

  it('survives quotes in values', () => {
    expect(roundTrip({ quote: ['he said "hi"'], apos: ["it's fine"] })).toEqual({
      quote: ['he said "hi"'],
      apos: ["it's fine"],
    })
  })

  it('survives backslashes in values', () => {
    expect(roundTrip({ path: ['C:\\Users\\dev'], regex: ['a\\.b'] })).toEqual({
      path: ['C:\\Users\\dev'],
      regex: ['a\\.b'],
    })
  })

  it('survives regex metacharacters in values', () => {
    expect(roundTrip({ regex: ['a.*b', '^foo$', '[a-z]+'] })).toEqual({
      regex: ['a.*b', '^foo$', '[a-z]+'],
    })
  })

  it('survives newlines and tabs in values', () => {
    expect(roundTrip({ multi: ['line1\nline2', 'col1\tcol2'] })).toEqual({
      multi: ['line1\nline2', 'col1\tcol2'],
    })
  })

  it('survives unicode (accents, emoji, CJK)', () => {
    expect(
      roundTrip({
        accents: ['héllo', 'naïve', 'für'],
        cjk: ['こんにちは', '你好'],
        emoji: ['🚀', '⚡'],
      }),
    ).toEqual({
      accents: ['héllo', 'naïve', 'für'],
      cjk: ['こんにちは', '你好'],
      emoji: ['🚀', '⚡'],
    })
  })

  it('preserves multiple distinct keys in the same map', () => {
    const flags = {
      transports: ['smtp', 'resend'],
      queue: ['redis'],
      ssl: ['true'],
      regex: ['a=b'],
    }
    expect(roundTrip(flags)).toEqual(flags)
  })

  it('survives carriage return in isolation', () => {
    // `\r` alone (not part of `\r\n`) — distinct from `\n` already covered.
    expect(roundTrip({ multi: ['line1\rline2'] })).toEqual({
      multi: ['line1\rline2'],
    })
  })

  it('survives U+2028 / U+2029 line/paragraph separators', () => {
    // Pre-ES2019 these were illegal inside JS string literals (but always
    // valid inside JSON strings). Older Node / transpilers can choke. Worth
    // pinning the contract for the inline `node -e` pipeline.
    expect(
      roundTrip({
        line: ['a b'],
        para: ['a b'],
      }),
    ).toEqual({
      line: ['a b'],
      para: ['a b'],
    })
  })

  it('survives NUL byte', () => {
    expect(roundTrip({ binary: ['a\0b'] })).toEqual({
      binary: ['a\0b'],
    })
  })

  it('survives BOM-prefixed value', () => {
    // `\uFEFF` at the start of a string — common when values come from BOM-
    // encoded files. JSON treats it as a regular char; verify it survives.
    expect(roundTrip({ utf8: ['\uFEFFhello'] })).toEqual({
      utf8: ['\uFEFFhello'],
    })
  })

  it('preserves user-typed key insertion order', () => {
    // ECMAScript guarantees insertion order for non-integer string keys, and
    // the Rust side now uses serde_json with `preserve_order` so the order
    // the user typed reaches the configure() hook unchanged.
    const flags = { zeta: ['1'], alpha: ['2'], middle: ['3'] }
    const out = roundTrip(flags)
    expect(Object.keys(out)).toEqual(['zeta', 'alpha', 'middle'])
  })
})
