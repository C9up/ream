interface FixtureMiddlewareContext {
  request: { url?: string }
}

class SampleMiddleware {
  async handle(_ctx: FixtureMiddlewareContext, next: () => Promise<void>): Promise<void> {
    await next()
  }
}

export default SampleMiddleware
