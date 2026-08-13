/**
 * The loaders and the manifest generator (Ace's `FsLoader`, `ListLoader`,
 * `IndexGenerator`).
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { IndexGenerator } from '../../src/console/IndexGenerator.js'
import { Kernel } from '../../src/console/Kernel.js'
import { FsLoader } from '../../src/console/loaders.js'

const FIXTURES = new URL('../fixtures/console-app/commands/', import.meta.url)

describe('FsLoader', () => {
  it('reports where each command was found', async () => {
    const metadata = await new FsLoader(FIXTURES).getMetaData()
    const greet = metadata.find((command) => command.commandName === 'greet')

    // `filePath` is what lets a generated manifest import the command later
    // without scanning anything.
    expect(greet?.filePath).toBe('./greet.ts')
  })

  it('answers nothing for a directory that is not there', async () => {
    const loader = new FsLoader(new URL('../fixtures/nope/', import.meta.url))
    expect(await loader.getMetaData()).toEqual([])
  })

  it('honours the filter it was given', async () => {
    const loader = new FsLoader(FIXTURES, (filePath) => filePath.endsWith('greet.ts'))
    const metadata = await loader.getMetaData()
    expect(metadata.map((command) => command.commandName)).toEqual(['greet'])
  })
})

describe('IndexGenerator', () => {
  it('writes a manifest a kernel can load without scanning', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ream-commands-'))
    await writeFile(
      join(directory, 'ping.js'),
      `export default class Ping {
        static commandName = 'ping'
        static description = 'Pings'
        static args = []
        static flags = []
        run() {}
      }\n`,
    )

    const manifest = await new IndexGenerator(directory).generate()
    expect(manifest.version).toBe(1)
    expect(manifest.commands.map((command) => command.commandName)).toEqual(['ping'])

    const written = JSON.parse(await readFile(join(directory, 'commands.json'), 'utf-8'))
    expect(written.commands[0].filePath).toBe('./ping.js')

    // The generated loader is a CommandLoader: the kernel takes it as-is, and
    // reading the manifest imports nothing.
    const loader = await import(pathToFileURL(join(directory, 'main.js')).href)
    const kernel = new Kernel()
    kernel.addLoader(loader)
    await kernel.boot()

    expect(kernel.hasCommand('ping')).toBe(true)
    expect((await kernel.find('ping')).commandName).toBe('ping')
  })
})
