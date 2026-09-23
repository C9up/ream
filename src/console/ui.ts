/**
 * The one colour helper the Kernel's help and the prompts use.
 *
 * It is a thin call into `@c9up/lumen` rather than a second palette: two
 * tables of escape codes in one package is how `[ warn ]` ends up yellow in
 * one command and plain in another.
 *
 * The environment is read on EVERY call, not cached, because a command can be
 * run in-process with the environment changed around it — which is exactly
 * what the tests covering `FORCE_COLOR` do.
 */

import { stdout } from 'node:process'
import { ansiColors, type Colors, silentColors, supportsColor } from '@c9up/lumen'

export type Colour = 'dim' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan'

export function colourise(
  text: string,
  colour: Colour,
  stream: NodeJS.WriteStream = stdout,
): string {
  const colors: Colors = supportsColor(stream) ? ansiColors() : silentColors()
  return colors[colour](text)
}
