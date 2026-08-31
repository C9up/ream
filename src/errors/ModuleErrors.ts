/**
 * Module-specific error subclasses.
 *
 * Each module gets its own error class with appropriate defaults.
 *
 * Every code these produce is `E_<MODULE>_<REASON>`: `E_` because that is what
 * every framework code carries, the module name because a bare `E_NOT_FOUND`
 * would not say which half of the framework raised it.
 *
 * @implements FR71
 */

import { ReamError } from './ReamError.js'

/** Container / IoC errors */
export class ContainerError extends ReamError {
  constructor(code: string, message: string, options?: ConstructorParameters<typeof ReamError>[2]) {
    super(code.startsWith('E_') ? code : `E_CONTAINER_${code}`, message, options)
    this.name = 'ContainerError'
  }
}

/** Router errors */
export class RouterError extends ReamError {
  constructor(code: string, message: string, options?: ConstructorParameters<typeof ReamError>[2]) {
    super(code.startsWith('E_') ? code : `E_ROUTER_${code}`, message, options)
    this.name = 'RouterError'
  }
}

/** Pipeline / Middleware errors */
export class PipelineError extends ReamError {
  constructor(code: string, message: string, options?: ConstructorParameters<typeof ReamError>[2]) {
    super(code.startsWith('E_') ? code : `E_PIPELINE_${code}`, message, options)
    this.name = 'PipelineError'
  }
}

/** Atlas ORM errors */
export class AtlasError extends ReamError {
  constructor(code: string, message: string, options?: ConstructorParameters<typeof ReamError>[2]) {
    super(code.startsWith('E_') ? code : `E_ATLAS_${code}`, message, options)
    this.name = 'AtlasError'
  }
}

/** Rune validation errors */
export class RuneError extends ReamError {
  constructor(code: string, message: string, options?: ConstructorParameters<typeof ReamError>[2]) {
    super(code.startsWith('E_') ? code : `E_RUNE_${code}`, message, options)
    this.name = 'RuneError'
  }
}

/** Warden auth errors */
export class WardenError extends ReamError {
  constructor(code: string, message: string, options?: ConstructorParameters<typeof ReamError>[2]) {
    super(code.startsWith('E_') ? code : `E_WARDEN_${code}`, message, options)
    this.name = 'WardenError'
  }
}

/** Event bus errors */
export class EventsError extends ReamError {
  constructor(code: string, message: string, options?: ConstructorParameters<typeof ReamError>[2]) {
    super(code.startsWith('E_') ? code : `E_EVENTS_${code}`, message, options)
    this.name = 'EventsError'
  }
}

/** Forge CLI errors */
export class ForgeError extends ReamError {
  constructor(code: string, message: string, options?: ConstructorParameters<typeof ReamError>[2]) {
    super(code.startsWith('E_') ? code : `E_FORGE_${code}`, message, options)
    this.name = 'ForgeError'
  }
}
