import { describe, expect, it } from 'vitest'
import { resolveNamedRoute, TestClient } from '../../src/testing/TestClient.js'

const noopBoot = async (port: number) => ({ port, close: () => {} })

describe('TestClient > resolveNamedRoute', () => {
  const manifest = {
    'users.index': '/users',
    'users.show': '/users/:id',
    'posts.comment': '/posts/:postId/comments/:id?',
  }

  it('fills :param placeholders (word-boundary safe)', () => {
    expect(resolveNamedRoute(manifest, 'users.show', { id: '42' })).toBe('/users/42')
    expect(resolveNamedRoute(manifest, 'posts.comment', { postId: '7', id: '3' })).toBe(
      '/posts/7/comments/3',
    )
  })

  it('strips unprovided optional segments', () => {
    expect(resolveNamedRoute(manifest, 'posts.comment', { postId: '7' })).toBe('/posts/7/comments')
  })

  it('throws a clear error on an unknown route name', () => {
    expect(() => resolveNamedRoute(manifest, 'nope', {})).toThrow(
      expect.objectContaining({
        code: 'E_CANNOT_LOOKUP_ROUTE',
        status: 500,
        message: 'Cannot lookup route "nope"',
        help: 'The route manifest names: users.index, users.show, posts.comment',
      }),
    )
  })

  it('throws when a required param is missing', () => {
    expect(() => resolveNamedRoute(manifest, 'users.show', {})).toThrow(
      expect.objectContaining({
        code: 'E_MISSING_ROUTE_PARAMS',
        message: expect.stringMatching(/missing params :id/),
      }),
    )
  })
})

describe('TestClient > visit', () => {
  it('throws when no routes manifest was configured', () => {
    const client = new TestClient(noopBoot)
    expect(() => client.visit('users.show', { id: '1' })).toThrow(
      expect.objectContaining({
        code: 'E_TEST_CLIENT_NO_ROUTE_MANIFEST',
        message: expect.stringMatching(/needs a named-route manifest/),
      }),
    )
  })

  it('surfaces the resolver error for an unknown route', () => {
    const client = new TestClient(noopBoot, { routes: { home: '/' } })
    expect(() => client.visit('missing')).toThrow('Cannot lookup route "missing"')
  })
})
