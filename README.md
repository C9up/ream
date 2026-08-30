# @c9up/ream

Rust-powered Node.js application framework. Convention over configuration with native performance.

`@c9up/ream` ships as a single package containing both the TypeScript framework and prebuilt Rust (NAPI) binaries — consumers never compile anything.

## Features

- **IoC Container** — `@Service()`, `@Inject()`, auto-resolution, scopes
- **Lifecycle** — register → boot → start → ready → shutdown
- **Router** — fluent chaining, groups, params, guards, versioning, named routes + `urlFor()` URL builder (`namedManifest()` exposes them to the client)
- **Middleware pipeline** — onion pattern, global + named, guard enforcement
- **HTTP server** — Rust Hyper via NAPI
- **Event bus** — in-process emitter with optional Redis store (`@c9up/ream/events`)
- **Scheduler** — cron/interval tasks via the `@Schedule()` decorator (Rust-backed)
- **GraphQL & RPC** — built-in GraphQL engine and typed RPC router
- **Security primitives** — signed cookies, HMAC, signed URLs, trusted-proxy config (request-filter security — XSS / CSRF / rate-limiting — lives in [@c9up/blackhole](https://github.com/C9up/blackhole))
- **Error DX** — structured errors, fuzzy matching, pipeline stage context
- **Health check** — Kubernetes-compatible `/health` endpoint
- **Graceful shutdown** — SIGTERM/SIGINT with drain timeout

## Quick Start

```typescript
import { Ignitor } from '@c9up/ream'

const app = new Ignitor({ port: 3000 })
  .httpServer()
  .routes((router) => {
    router.get('/hello/:name', async ({ params, response }) => {
      response.status(200).send(`Hello, ${params.name}!`)
    })
  })

await app.start()
```

## Testing

Declare your suites in `reamrc.ts`, the way AdonisJS declares them in
`adonisrc.ts`, and `ream test` runs them:

```ts
// reamrc.ts
export default defineConfig({
  tests: {
    timeout: 2_000,
    forceExit: false,
    suites: [
      { name: 'unit', files: ['tests/unit/**/*.spec.(js|ts)'] },
      {
        name: 'functional',
        files: ['tests/functional/**/*.spec.ts'],
        timeout: 30_000,
        // The per-suite `configure`. Costs an import of this file in every
        // worker — `configureSuite` in tests/bootstrap.ts does the same for free.
        configure: (suite) => suite.setup(() => startHttpServer()),
      },
    ],
  },
})
```

```sh
ream test                    # every suite, in order
ream test functional         # one suite
ream test --bail --threads=4
```

`ream test` sets `NODE_ENV=test` and loads the `.env` files itself, before
spawning anything: `.env.test` wins over `.env`, `.env.local` is skipped so
a developer's local overrides never decide what CI runs, and the shell keeps
the last word. The app writes no hook for this — the workers inherit the
environment of the process that spawned them.

`forceExit: true` makes the run call `process.exit()` once it ends instead
of waiting for the event loop to drain — the answer to a pool or a server the app left open. Without it the
process exits on its own, so a leaked handle surfaces as a diagnosable
hang rather than being swallowed.

The stratification is AdonisJS's: ream reads its rc file and hands the
suites to the runner ([`@c9up/helix`](../helix)), exactly as
`@adonisjs/core` reads `adonisrc.ts` and hands them to its own runner. helix knows
nothing about ream, and ream owns no test execution. `tests/bootstrap.ts`
— plugins, `runnerHooks`, `configureSuite` — is helix's, unchanged.

Driving it yourself (a `bin/test.ts`, a console command) is the same call:

```ts
import { runTestsFromRcFile } from '@c9up/helix-plugin-ream/runner'

process.exitCode = await runTestsFromRcFile('./reamrc.ts', {
  suites: process.argv.slice(2),
})
```

## Ecosystem

Every package is standalone and publishable on its own; they consume the Ream
universe through the container, never via a static import.

| Package | Description |
|---------|-------------|
| [@c9up/atlas](https://github.com/C9up/atlas) | Data Mapper ORM |
| [@c9up/eon](https://github.com/C9up/eon) | Time-series data layer (TDengine-backed) |
| [@c9up/rune](https://github.com/C9up/rune) | Validation engine |
| [@c9up/warden](https://github.com/C9up/warden) | Authentication |
| [@c9up/transit](https://github.com/C9up/transit) | Federated sign-in (SAML 2.0, OpenID Connect, OAuth1, OAuth2) |
| [@c9up/sigil](https://github.com/C9up/sigil) | Password hashing (argon2, bcrypt, scrypt) |
| [@c9up/blackhole](https://github.com/C9up/blackhole) | Security filter — XSS, CSRF, rate-limiting (Rust-native) |
| [@c9up/spectrum](https://github.com/C9up/spectrum) | Structured logging |
| [@c9up/rosetta](https://github.com/C9up/rosetta) | Internationalization (i18n) |
| [@c9up/chronos](https://github.com/C9up/chronos) | Date/time & recurrence engine |
| [@c9up/atom](https://github.com/C9up/atom) | Exact decimal arithmetic |
| [@c9up/bay](https://github.com/C9up/bay) | Job queue (memory + Redis drivers) |
| [@c9up/echo](https://github.com/C9up/echo) | Cache (memory + Redis drivers) |
| [@c9up/quasar](https://github.com/C9up/quasar) | Redis connections (named, pub/sub, health checks) |
| [@c9up/archive](https://github.com/C9up/archive) | File storage (Local + S3-compatible) |
| [@c9up/rover](https://github.com/C9up/rover) | Mail transport (SMTP, log, pluggable) |
| [@c9up/nova](https://github.com/C9up/nova) | Web Push notifications (VAPID) |
| [@c9up/relay](https://github.com/C9up/relay) | Realtime transport (SSE; WebSocket Hub protocol implemented, no server upgrade point yet) |
| [@c9up/comet](https://github.com/C9up/comet) | JSON-RPC 2.0 protocol + isomorphic client |
| [@c9up/aurora](https://github.com/C9up/aurora) | Reactive UI runtime (SSR + hydration) |
| [@c9up/photon](https://github.com/C9up/photon) | Frontend rendering engine |
| [@c9up/inker](https://github.com/C9up/inker) | Server-side templating |
| [@c9up/station](https://github.com/C9up/station) | Admin scaffolding |
| [@c9up/helix](https://github.com/C9up/helix) | Framework-agnostic test runtime |
| [@c9up/helix-plugin-ream](https://github.com/C9up/helix-plugin-ream) | The ream↔helix bridge (boots a Ream app under test) |
| [@c9up/ream-cli](https://github.com/C9up/ream-cli) | CLI & code generators (Rust binary, `ream` command) |
| [@c9up/ream-mcp](https://github.com/C9up/ream-mcp) | MCP server — agent-ready framework assistant |

## License

MIT
