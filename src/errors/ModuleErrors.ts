/**
 * Module-specific error subclasses.
 *
 * Each module gets its own error class with appropriate defaults.
 *
 * @implements FR71
 */

import { ReamError } from './ReamError.js'

/** Container / IoC errors */
export class ContainerError extends ReamError {
  constructor(code: string, message: string, options?: ConstructorParameters<typeof ReamError>[2]) {
    super(`CONTAINER_${code}`, message, options)
    this.name = 'ContainerError'
  }
}

/** Router errors */
export class RouterError extends ReamError {
  constructor(code: string, message: string, options?: ConstructorParameters<typeof ReamError>[2]) {
    super(`ROUTER_${code}`, message, options)
    this.name = 'RouterError'
  }
}

/** Pipeline / Middleware errors */
export class PipelineError extends ReamError {
  constructor(code: string, message: string, options?: ConstructorParameters<typeof ReamError>[2]) {
    super(`PIPELINE_${code}`, message, options)
    this.name = 'PipelineError'
  }
}

/** Atlas ORM errors */
export class AtlasError extends ReamError {
  constructor(code: string, message: string, options?: ConstructorParameters<typeof ReamError>[2]) {
    super(`ATLAS_${code}`, message, options)
    this.name = 'AtlasError'
  }
}

/** Rune validation errors */
export class RuneError extends ReamError {
  constructor(code: string, message: string, options?: ConstructorParameters<typeof ReamError>[2]) {
    super(`RUNE_${code}`, message, options)
    this.name = 'RuneError'
  }
}

/** Warden auth errors */
export class WardenError extends ReamError {
  constructor(code: string, message: string, options?: ConstructorParameters<typeof ReamError>[2]) {
    super(`WARDEN_${code}`, message, options)
    this.name = 'WardenError'
  }
}

/** Pulsar bus errors */
export class PulsarError extends ReamError {
  constructor(code: string, message: string, options?: ConstructorParameters<typeof ReamError>[2]) {
    super(`PULSAR_${code}`, message, options)
    this.name = 'PulsarError'
  }
}

/** Forge CLI errors */
export class ForgeError extends ReamError {
  constructor(code: string, message: string, options?: ConstructorParameters<typeof ReamError>[2]) {
    super(`FORGE_${code}`, message, options)
    this.name = 'ForgeError'
  }
}
