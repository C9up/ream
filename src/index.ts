/**
 * @module @c9up/ream
 * @description Ream — Rust-powered Node.js application framework
 * @implements FR11, FR12, FR13, FR14, FR16, FR17, FR18, FR19, FR20, FR21
 */

import 'reflect-metadata'

// ─── Core ───────────────────────────────────────────────────

export { Application } from './Application.js'
export { SimpleConfigStore, defineModuleConfig, env } from './ConfigLoader.js'
export { Container } from './container/Container.js'
export type { Binding, ServiceFactory, ServiceScope, ServiceToken } from './container/types.js'

// ─── HTTP (new — AdonisJS-compatible) ───────────────────────

export { HttpContext } from './http/HttpContext.js'
export type { AuthState, RouteInfo } from './http/HttpContext.js'
export { Request } from './http/Request.js'
export type { RawRequest } from './http/Request.js'
export { Response } from './http/Response.js'
export { RedirectBuilder } from './http/RedirectBuilder.js'
export {
  Exception,
  ExceptionHandler,
  E_ROUTE_NOT_FOUND,
  E_UNAUTHORIZED,
  E_FORBIDDEN,
  E_VALIDATION_ERROR,
  E_ROW_NOT_FOUND,
  E_HTTP_EXCEPTION,
} from './http/Exception.js'

// ─── Context (legacy — for event transport) ─────────────────

export { Context } from './Context.js'

// ─── Decorators ─────────────────────────────────────────────

export { Inject, Service, inject, clearServiceRegistry, getServiceMetadata, getServiceRegistry } from './decorators/Service.js'
export { Lazy, createLazyProxy, getLazyParams } from './decorators/Lazy.js'

// ─── Router ─────────────────────────────────────────────────

export { Router, RouteBuilder, GroupBuilder, OnRouteBuilder, matchers } from './router/Router.js'
export type { ControllerAction, MatchResult, ParamMatcher, RouteDefinition, RouteHandler, RouteHandlerFunction } from './router/Router.js'

// ─── Middleware ──────────────────────────────────────────────

export { MiddlewareRegistry, compose } from './middleware/Pipeline.js'
export type { MiddlewareFunction } from './middleware/Pipeline.js'

// ─── HttpKernel ─────────────────────────────────────────────

export { createHttpKernel } from './HttpKernel.js'
export type { HttpKernelConfig } from './HttpKernel.js'

// ─── Server ─────────────────────────────────────────────────

export { Server, resolveMiddlewareEntry } from './server/Server.js'
export type { LazyImport, ErrorHandlerClass, MiddlewareClass, MiddlewareEntry } from './server/Server.js'

// ─── Ignitor ────────────────────────────────────────────────

export { Ignitor, defineConfig, prettyPrintError } from './Ignitor.js'
export type { AppEnvironment, HyperServerLike, IgnitorConfig, ReamrcConfig } from './Ignitor.js'

// ─── Providers ──────────────────────────────────────────────

export { Provider } from './Provider.js'
export type { AppContext, ConfigStore } from './Provider.js'

// ─── Errors ─────────────────────────────────────────────────

export { ErrorBoundary } from './ErrorBoundary.js'
export type { ErrorEmitter, ErrorEvent, ErrorSeverity } from './ErrorBoundary.js'
export { ReamError } from './errors/ReamError.js'
export {
  AtlasError,
  ContainerError,
  ForgeError,
  PipelineError,
  PulsarError,
  RouterError,
  RuneError,
  WardenError,
} from './errors/ModuleErrors.js'
export { didYouMean, findClosestMatches, levenshtein } from './errors/FuzzyMatcher.js'
export { PIPELINE_STAGES, createPipelineError, validatePipelineConfig } from './errors/PipelineStageError.js'
export type { PipelineStageName } from './errors/PipelineStageError.js'

// ─── Utilities ──────────────────────────────────────────────

export { HealthCheck } from './HealthCheck.js'
export type { HealthChecker, HealthCheckResult, HealthStatus } from './HealthCheck.js'
export { installGracefulShutdown } from './GracefulShutdown.js'
export type { ShutdownHandle, ShutdownOptions } from './GracefulShutdown.js'
export { startHotReload } from './HotReload.js'
export type { HotReloadOptions } from './HotReload.js'

// ─── Types ──────────────────────────────────────────────────

export type {
  AsyncOrSync,
  Constructor,
  ExtractFunctions,
  InferRouteParams,
  OneOrMore,
  Opaque,
  Prettify,
  UnwrapOpaque,
} from './types/helpers.js'

// ─── Services ───────────────────────────────────────────────

export { _setApp } from './services/app.js'
export { _setRouter } from './services/router.js'
export { _setServer } from './services/server.js'

export const VERSION = '0.1.0'
