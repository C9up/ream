/**
 * `NODE_ENV` aliases.
 *
 * `NODE_ENV=prod` is what a Dockerfile or a platform dashboard commonly holds,
 * and reading it verbatim answers "not production" — which ships the session
 * cookie without Secure, serves development error pages, and loads the wrong
 * `.env` file. Every one of those is a security decision made by a spelling.
 */
import 'reflect-metadata'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Application } from '../../src/Application.js'
import { loadEnvFiles } from '../../src/env/loadEnvFiles.js'
import { normalizeNodeEnv } from '../../src/env/nodeEnv.js'

describe('normalizeNodeEnv', () => {
  it('folds the development spellings', () => {
    for (const value of ['dev', 'develop', 'development', 'DEV', 'Development']) {
      expect(normalizeNodeEnv(value), value).toBe('development')
    }
  })

  it('folds the production spellings', () => {
    for (const value of ['prod', 'production', 'PROD', 'Production']) {
      expect(normalizeNodeEnv(value), value).toBe('production')
    }
  })

  it('folds the test spellings', () => {
    for (const value of ['test', 'testing', 'TEST']) {
      expect(normalizeNodeEnv(value), value).toBe('test')
    }
  })

  it('hands anything else back lowercased, rather than bucketing it', () => {
    // `staging` is a real environment with its own `.env.staging`; forcing it
    // into one of the three buckets would load the wrong file.
    expect(normalizeNodeEnv('staging')).toBe('staging')
    expect(normalizeNodeEnv('STAGING')).toBe('staging')
    expect(normalizeNodeEnv('qa')).toBe('qa')
  })

  it('answers unknown for an absent value', () => {
    // Absent is not development: treating it as such makes a misconfigured
    // deploy silently permissive.
    expect(normalizeNodeEnv(undefined)).toBe('unknown')
    expect(normalizeNodeEnv('')).toBe('unknown')
  })
})

describe('Application > the environment questions honour the aliases', () => {
  let previous: string | undefined

  beforeEach(() => {
    previous = process.env.NODE_ENV
  })

  afterEach(() => {
    if (previous === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous
  })

  it('reads NODE_ENV=prod as production', () => {
    process.env.NODE_ENV = 'prod'
    const app = new Application()

    expect(app.inProduction).toBe(true)
    expect(app.inDev).toBe(false)
    expect(app.nodeEnvironment).toBe('production')
  })

  it('reads NODE_ENV=testing as test', () => {
    process.env.NODE_ENV = 'testing'
    const app = new Application()

    expect(app.inTest).toBe(true)
    expect(app.inDev).toBe(false)
  })

  it('reads NODE_ENV=develop as development', () => {
    process.env.NODE_ENV = 'develop'
    const app = new Application()

    expect(app.inDev).toBe(true)
    expect(app.inProduction).toBe(false)
  })

  it('does NOT call an absent environment development', () => {
    delete process.env.NODE_ENV
    const app = new Application()

    // `inDev` is an exact match, not "anything that is not production or
    // test". An unconfigured machine reading as development turns on the hot
    // reload watcher, the GraphQL playground and full error pages.
    expect(app.nodeEnvironment).toBe('unknown')
    expect(app.inDev).toBe(false)
    expect(app.inProduction).toBe(false)
    expect(app.inTest).toBe(false)
  })

  it('does NOT call a staging box development either', () => {
    process.env.NODE_ENV = 'staging'
    const app = new Application()

    expect(app.inDev).toBe(false)
  })

  it('says development only for the development spellings', () => {
    for (const value of ['dev', 'develop', 'development']) {
      process.env.NODE_ENV = value
      expect(new Application().inDev, value).toBe(true)
    }
  })

  it('leaves an unrecognised environment alone', () => {
    process.env.NODE_ENV = 'staging'
    const app = new Application()

    expect(app.nodeEnvironment).toBe('staging')
    expect(app.inProduction).toBe(false)
  })
})

describe('loadEnvFiles > picks the file the deployment actually wrote', () => {
  const created: string[] = []
  let previous: string | undefined

  beforeEach(() => {
    previous = process.env.NODE_ENV
    delete process.env.REAM_ALIAS_PROBE
  })

  afterEach(() => {
    if (previous === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous
    delete process.env.REAM_ALIAS_PROBE
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('loads .env.production when NODE_ENV=prod', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ream-alias-'))
    created.push(dir)
    writeFileSync(join(dir, '.env.production'), 'REAM_ALIAS_PROBE=from_production\n')
    process.env.NODE_ENV = 'prod'

    loadEnvFiles(pathToFileURL(`${dir}/`))

    // Looking for `.env.prod` would have found nothing, and the deployment's
    // real configuration would never load.
    expect(process.env.REAM_ALIAS_PROBE).toBe('from_production')
  })

  it('still loads .env.staging for an unrecognised environment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ream-alias-'))
    created.push(dir)
    writeFileSync(join(dir, '.env.staging'), 'REAM_ALIAS_PROBE=from_staging\n')
    process.env.NODE_ENV = 'staging'

    loadEnvFiles(pathToFileURL(`${dir}/`))

    expect(process.env.REAM_ALIAS_PROBE).toBe('from_staging')
  })
})
