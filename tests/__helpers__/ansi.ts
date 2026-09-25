/**
 * Strip the colour out of a line, so an assertion is about the words.
 *
 * The pattern is built rather than written as a literal: the escape it matches
 * is a control character, and a regex literal holding one is exactly what
 * `noControlCharactersInRegex` exists to catch. Computing it says out loud
 * that this one is on purpose, and costs a suppression comment nobody would
 * read twice.
 */
const ESCAPE = String.fromCharCode(0x1b)
const SGR = new RegExp(`${ESCAPE}\\[\\d+m`, 'g')

/** The line without its SGR sequences. */
export function plain(line: string): string {
  return line.replaceAll(SGR, '')
}

/** Whether a string carries any colour at all. */
export function hasColor(value: string): boolean {
  return value.includes(ESCAPE)
}
