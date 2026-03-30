# @c9up/ream

Rust-powered Node.js application framework. Convention over configuration with native performance.

## Features

- **IoC Container** — `@Service()`, `@Inject()`, auto-resolution, scopes
- **4-phase lifecycle** — register → boot → start → ready → shutdown
- **Router** — fluent chaining, groups, params, guards, versioning
- **Middleware pipeline** — onion pattern, global + named, guard enforcement
- **HTTP server** — Rust Hyper via NAPI (195k req/s hello world)
- **Security** — XSS sanitization, CSRF tokens, rate limiting (Rust-side, before NAPI)
- **Error DX** — structured errors, fuzzy matching, pipeline stage context
- **Health check** — Kubernetes-compatible `/health` endpoint
- **Graceful shutdown** — SIGTERM/SIGINT with drain timeout

## Quick Start

```typescript
import { Ignitor } from '@c9up/ream'

const app = new Ignitor({ port: 3000 })
  .httpServer()
  .routes((router) => {
    router.get('/hello/:name', async (ctx) => {
      ctx.response!.body = `Hello, ${ctx.params?.name}!`
    })
  })

await app.start()
```

## Ecosystem

| Package | Description |
|---------|-------------|
| [@c9up/pulsar](https://github.com/C9up/pulsar) | Rust-powered event bus |
| [@c9up/atlas](https://github.com/C9up/atlas) | Data Mapper ORM |
| [@c9up/rune](https://github.com/C9up/rune) | Validation engine |
| [@c9up/warden](https://github.com/C9up/warden) | Authentication & RBAC |
| [@c9up/spectrum](https://github.com/C9up/spectrum) | Structured logging |
| [@c9up/forge](https://github.com/C9up/forge) | CLI & code generators |
| [create-ream](https://github.com/C9up/create-ream) | Project scaffolding |

## License

MIT
