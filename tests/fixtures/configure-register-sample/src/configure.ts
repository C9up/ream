import type { Codemods } from '../../../../src/Codemods.ts'

export async function configure(codemods: Codemods): Promise<void> {
  await codemods.registerCommand('@test-fixture/register-sample/commands/echo')
  await codemods.registerMiddleware('@test-fixture/register-sample/middleware/sample')
}
