export interface EventsConfig {
  /** Event store backend. Default in-memory; `"redis"` needs the `redis-store` build. */
  store?: string
  /** Max delivery retries for durable subscribers. */
  retries?: number
}

export function defineConfig(config: EventsConfig): EventsConfig {
  return config
}
