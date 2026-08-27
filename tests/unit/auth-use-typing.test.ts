import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import type { AuthState } from '../../src/index.js'

/**
 * `ctx.auth.use(name)` returned `unknown`, so reaching a guard needed a cast
 * that lies about a contract ream does not own — apps worked around it through
 * `authenticateUsing(['session'])` instead.
 *
 * It is typed through the augmentable `Authenticators` interface now, the same
 * mechanism AdonisJS uses. This file augments it the way an auth package would,
 * then reads a guard back: if the augmentation stopped being honoured, the
 * assignment below would not compile.
 */
interface SessionGuard {
  readonly name: 'session'
  logout(): Promise<void>
}

declare module '../../src/types/authenticators.js' {
  interface Authenticators {
    session: SessionGuard
  }
}

describe('ctx.auth.use > typing', () => {
  it('hands back the augmented guard type for a known name', () => {
    const auth: AuthState = {
      isAuthenticated: true,
      use(name: string) {
        return { name, async logout() {} }
      },
    }
    // Typed as SessionGuard by the augmentation above — no cast.
    const guard = auth.use?.('session')
    expect(guard?.name).toBe('session')
  })

  it('still resolves an unknown name rather than failing to compile', () => {
    // A host that augments nothing keeps the previous behaviour as its floor.
    const auth: AuthState = { isAuthenticated: false, use: (name: string) => name }
    expect(auth.use?.('whatever')).toBe('whatever')
  })
})
