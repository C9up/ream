/**
 * `session.tag()` at login, on the database store, over HTTP.
 *
 * At login the session id was just created or regenerated, so its row does
 * not exist when the handler tags it: the store's `UPDATE … SET user_id` matched
 * nothing, and the row `commit()` inserted afterwards carried no user. "Log out
 * from all my devices" then found no session to destroy.
 */
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createHyperServerFactory } from '../../src/bootstrap/hyper-server.js'
import type { HttpContext } from '../../src/http/HttpContext.js'
import { Ignitor, SessionMiddleware } from '../../src/index.js'
import type { SessionDbConnection } from '../../src/session/drivers/DatabaseDriver.js'

const db = new DatabaseSync(':memory:')
// The table the guide documents for the database store.
db.exec(
  'CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT, expires_at INTEGER, user_id TEXT NULL)',
)

function bindable(params: unknown[] = []): Array<string | number | null> {
  return params.map((p) =>
    typeof p === 'number' || typeof p === 'string' || p === null ? p : String(p),
  )
}

const connection: SessionDbConnection = {
  async query(sql, params) {
    return db.prepare(sql).all(...bindable(params))
  },
  async execute(sql, params) {
    return { rowsAffected: Number(db.prepare(sql).run(...bindable(params)).changes) }
  },
}

function rows(): Array<Record<string, unknown>> {
  return db.prepare('SELECT id, user_id FROM sessions').all()
}

function cookieOf(res: Response): string {
  return (res.headers.getSetCookie()[0] ?? '').split(';')[0] ?? ''
}

/** The request's session; the session middleware is mounted on every route here. */
function sessionOf(ctx: HttpContext): NonNullable<HttpContext['session']> {
  const session = ctx.session
  if (session === undefined) throw new Error('the session middleware is not mounted')
  return session
}

/** What an auth guard's login does: rotate the id, then seat the user. */
function signIn(ctx: HttpContext): void {
  sessionOf(ctx).regenerate()
  sessionOf(ctx).put('auth_user_id', '7')
}

describe('session > tag() at login on the database store', () => {
  let ignitor: Ignitor
  let port = 0
  const previousKey = process.env.APP_KEY

  beforeAll(async () => {
    process.env.APP_KEY = 'k'.repeat(32)
    const session = new SessionMiddleware({
      driver: 'database',
      dbConnection: connection,
      gcProbability: 0,
    })
    ignitor = await new Ignitor({
      port: 0,
      gracefulShutdown: false,
      serverFactory: createHyperServerFactory(),
    })
      .use((ctx, next) => session.handle(ctx, next))
      .routes((router) => {
        router.get('/form', (ctx) => {
          sessionOf(ctx).put('seen', true)
          return ctx.response.json({ ok: true })
        })
        router.post('/login', async (ctx) => {
          signIn(ctx)
          await sessionOf(ctx).tag('7')
          return ctx.response.json({ ok: true })
        })
        router.post('/login-tag-first', async (ctx) => {
          await sessionOf(ctx).tag('7')
          signIn(ctx)
          return ctx.response.json({ ok: true })
        })
        router.post('/login-no-rotation', async (ctx) => {
          sessionOf(ctx).put('auth_user_id', '7')
          await sessionOf(ctx).tag('7')
          return ctx.response.json({ ok: true })
        })
        router.post('/login-then-untag', async (ctx) => {
          signIn(ctx)
          await sessionOf(ctx).tag('7')
          await sessionOf(ctx).untag('7')
          return ctx.response.json({ ok: true })
        })
        router.post('/tag-only', async (ctx) => {
          await sessionOf(ctx).tag('7')
          return ctx.response.json({ ok: true })
        })
      })
      .httpServer()
      .start()
    port = await ignitor.port()
  })

  afterAll(async () => {
    await ignitor.stop()
    if (previousKey === undefined) delete process.env.APP_KEY
    else process.env.APP_KEY = previousKey
  })

  beforeEach(() => {
    db.exec('DELETE FROM sessions')
  })

  const post = (path: string, cookie = ''): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: cookie ? { cookie } : {},
    })

  it.each([
    ['tag after regenerate', '/login'],
    ['tag before regenerate', '/login-tag-first'],
    ['tag on a new session, no rotation', '/login-no-rotation'],
  ])('writes the user on the row of a first request (%s)', async (_label, path) => {
    const login = await post(path)
    expect(login.status).toBe(200)

    expect(rows()).toHaveLength(1)
    expect(rows()[0]?.user_id).toBe('7')

    // "Log out from all my devices" finds the session.
    const tagged = await connection.query('SELECT id FROM sessions WHERE user_id = ?', ['7'])
    expect(tagged).toEqual([{ id: rows()[0]?.id }])
  })

  it('tags the rotated row after an anonymous visit, and drops the old one', async () => {
    const anonymous = cookieOf(await fetch(`http://127.0.0.1:${port}/form`))
    expect(rows()).toEqual([expect.objectContaining({ user_id: null })])

    const login = await post('/login', anonymous)

    expect(login.status).toBe(200)
    expect(rows()).toEqual([expect.objectContaining({ user_id: '7' })])
  })

  it('tags an existing row in place', async () => {
    const anonymous = cookieOf(await fetch(`http://127.0.0.1:${port}/form`))

    await post('/login-no-rotation', anonymous)

    expect(rows()).toEqual([expect.objectContaining({ user_id: '7' })])
  })

  it('does not replay a tag the request removed', async () => {
    await post('/login-then-untag')

    expect(rows()).toEqual([expect.objectContaining({ user_id: null })])
  })

  it('creates no row for a session that holds no data', async () => {
    await post('/tag-only')

    expect(rows()).toEqual([])
  })
})
