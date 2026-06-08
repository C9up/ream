/**
 * GraphQL selection-set pruning — the security-relevant projection that stops
 * a resolver returning a rich object (e.g. an ORM entity with `passwordHash`)
 * from leaking fields the client never selected.
 *
 * Selection sets are produced by the Rust `ream-graphql` parser at runtime;
 * here we build `SelectionField[]` directly so the pruning logic is tested in
 * isolation (parser behaviour is covered by graphql-provider + the Rust crate).
 */
import { describe, expect, it } from 'vitest'
import { pruneToSelection, type SelectionField } from '../../src/graphql/GraphQLEngine.js'

/** Build a `SelectionField` (args are irrelevant to pruning). */
function f(name: string, selection: SelectionField[] = [], alias?: string): SelectionField {
  return { name, alias, args: {}, selection }
}

describe('graphql > pruneToSelection (data-leak guard)', () => {
  it('drops fields the client did not select from a rich resolver object', () => {
    const fields = [f('id'), f('email')]
    const resolved = { id: 1, email: 'a@b.com', passwordHash: 'secret', isAdmin: true }
    expect(pruneToSelection(resolved, fields)).toEqual({ id: 1, email: 'a@b.com' })
  })

  it('prunes recursively into nested selections', () => {
    const fields = [f('id'), f('author', [f('name')])]
    const resolved = {
      id: 1,
      author: { name: 'Kaen', ssn: '999-99-9999' },
      internalNote: 'leak',
    }
    expect(pruneToSelection(resolved, fields)).toEqual({ id: 1, author: { name: 'Kaen' } })
  })

  it('maps the projection over arrays', () => {
    const fields = [f('users', [f('id')])]
    const resolved = {
      users: [
        { id: 1, token: 'x' },
        { id: 2, token: 'y' },
      ],
    }
    expect(pruneToSelection(resolved, fields)).toEqual({ users: [{ id: 1 }, { id: 2 }] })
  })

  it('honours aliases (result keyed by alias, read from real field name)', () => {
    const fields = [f('id', [], 'uid')]
    expect(pruneToSelection({ id: 7, secret: 's' }, fields)).toEqual({ uid: 7 })
  })

  it('returns a scalar leaf untouched (empty selection)', () => {
    expect(pruneToSelection('hello', [])).toBe('hello')
    expect(pruneToSelection(42, [])).toBe(42)
  })

  it('does not invent keys the resolver never returned', () => {
    const fields = [f('id'), f('missing')]
    expect(pruneToSelection({ id: 1 }, fields)).toEqual({ id: 1 })
  })
})
