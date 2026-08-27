/**
 * The conventional directory layout, as `@adonisjs/application` exports it.
 *
 * Every path helper on {@link Application} reads this map, so an app that moves
 * a directory declares it once in `reamrc.ts` and every helper follows:
 *
 * ```ts
 * export default defineConfig({
 *   directories: { httpControllers: 'app/http/controllers' },
 * })
 * ```
 */
export interface DirectoriesNode {
  [key: string]: string
  config: string
  commands: string
  contracts: string
  public: string
  providers: string
  languageFiles: string
  migrations: string
  seeders: string
  factories: string
  views: string
  start: string
  tmp: string
  tests: string
  httpControllers: string
  models: string
  services: string
  exceptions: string
  mailers: string
  mails: string
  middleware: string
  policies: string
  validators: string
  events: string
  listeners: string
  transformers: string
  stubs: string
  generatedClient: string
  generatedServer: string
}

/**
 * Defaults, matching AdonisJS directory for directory.
 *
 * NAMED DEVIATION — the two generated directories are `.ream/*` where upstream
 * writes `.adonisjs/*`. A dot-directory in the user's project is product
 * identity, not layout.
 */
export const directories: DirectoriesNode = {
  config: 'config',
  commands: 'commands',
  contracts: 'contracts',
  public: 'public',
  providers: 'providers',
  languageFiles: 'resources/lang',
  migrations: 'database/migrations',
  seeders: 'database/seeders',
  factories: 'database/factories',
  views: 'resources/views',
  start: 'start',
  tmp: 'tmp',
  tests: 'tests',
  httpControllers: 'app/controllers',
  models: 'app/models',
  services: 'app/services',
  exceptions: 'app/exceptions',
  mailers: 'app/mailers',
  mails: 'app/mails',
  middleware: 'app/middleware',
  policies: 'app/policies',
  validators: 'app/validators',
  events: 'app/events',
  listeners: 'app/listeners',
  transformers: 'app/transformers',
  stubs: 'stubs',
  generatedClient: '.ream/client',
  generatedServer: '.ream/server',
}
