interface Codemods {
  addProvider(importPath: string): Promise<void>
  addEnvVars(vars: Record<string, string>): Promise<void>
  writeFile(filePath: string, content: string, options?: { force?: boolean }): Promise<void>
}

export async function configure(codemods: Codemods): Promise<void> {
  await codemods.addProvider('@c9up/ream/events/provider')
  await codemods.writeFile(
    'config/events.ts',
    `import { defineConfig } from '@c9up/ream/events/config'

export default defineConfig({
  store: 'memory',
  retries: 3,
})
`,
  )
}
