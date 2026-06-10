/**
 * @module @c9up/ream
 * @description Ream — Rust-powered Node.js application framework
 * @implements FR11, FR12, FR13, FR14, FR16, FR17, FR18, FR19, FR20, FR21
 */

import 'reflect-metadata'

// ─── Core ───────────────────────────────────────────────────

export { Application } from './Application.js'
export { ConfigStore, defineModuleConfig, env } from './ConfigLoader.js'
export { Container } from './container/Container.js'
export type { Binding, ServiceFactory, ServiceScope, ServiceToken } from './container/types.js'

// ─── HTTP (new — AdonisJS-compatible) ───────────────────────

export {
  E_FORBIDDEN,
  E_HTTP_EXCEPTION,
  E_ROUTE_NOT_FOUND,
  E_ROW_NOT_FOUND,
  E_UNAUTHORIZED,
  E_VALIDATION_ERROR,
  Exception,
  ExceptionHandler,
} from './http/Exception.js'
export type { AuthState, RouteInfo } from './http/HttpContext.js'
export { HttpContext } from './http/HttpContext.js'
export { RedirectBuilder } from './http/RedirectBuilder.js'
export type { RawRequest } from './http/Request.js'
export { Request } from './http/Request.js'
export { Response } from './http/Response.js'

// ─── Session ────────────────────────────────────────────────

export { CookieDriver as SessionCookieDriver } from './session/drivers/CookieDriver.js'
export { MemoryDriver as SessionMemoryDriver } from './session/drivers/MemoryDriver.js'
export type { SessionConfig, SessionDriver } from './session/Session.js'
export { Session } from './session/Session.js'
export { default as SessionMiddleware } from './session/SessionMiddleware.js'

// ─── Body Parser ────────────────────────────────────────────

export type { BodyParserConfig } from './bodyparser/BodyParserMiddleware.js'
export { default as BodyParserMiddleware } from './bodyparser/BodyParserMiddleware.js'
export type { FileValidationOptions } from './bodyparser/MultipartFile.js'
export { MultipartFile } from './bodyparser/MultipartFile.js'

// ─── JSON-RPC ───────────────────────────────────────────────

export type { RpcConfig, RpcProviderOptions } from './rpc/RpcProvider.js'
export { RpcProvider } from './rpc/RpcProvider.js'
export type { RpcHandler, RpcMethodDefinition } from './rpc/RpcRouter.js'
export { RpcMethodBuilder, RpcRouter } from './rpc/RpcRouter.js'

// ─── GraphQL ────────────────────────────────────────────────

export type {
  GraphQLConfig,
  ResolverOptions,
  SelectionField,
} from './graphql/GraphQLEngine.js'
export { GraphQLEngine } from './graphql/GraphQLEngine.js'
export type { GraphQLProviderOptions } from './graphql/GraphQLProvider.js'
export { GraphQLProvider } from './graphql/GraphQLProvider.js'

// ─── OpenAPI ────────────────────────────────────────────────

export type { OpenApiConfig } from './openapi/OpenApiGenerator.js'
export { OpenApiGenerator } from './openapi/OpenApiGenerator.js'
export type { OpenApiMiddlewareConfig } from './openapi/OpenApiMiddleware.js'
export { OpenApiMiddleware } from './openapi/OpenApiMiddleware.js'
export type {
  OpenApiDocsConfig,
  OpenApiProviderOptions,
} from './openapi/OpenApiProvider.js'
export { OpenApiProvider } from './openapi/OpenApiProvider.js'

// ─── API Resources / Serializers ────────────────────────────

export type { PaginationMeta } from './resources/ApiResource.js'
export { ApiResource } from './resources/ApiResource.js'

// ─── Static Files ───────────────────────────────────────────

export type { StaticConfig } from './storage/StaticMiddleware.js'
export { StaticMiddleware } from './storage/StaticMiddleware.js'
export type { StaticProviderOptions } from './storage/StaticProvider.js'
export { StaticProvider } from './storage/StaticProvider.js'

// ─── Security ───────────────────────────────────────────────

// Request-filter security (CSRF, XSS, rate-limit, CORS, headers, path/param)
// lives in @c9up/blackhole. ream core keeps only the crypto primitives.
export { CookieSigner } from './security/CookieSigner.js'
export {
  constantTimeEq,
  hasNativeCrypto,
  hmacSign,
  hmacVerify,
  randomBytesBase64,
  randomHex,
  setNapi,
} from './security/crypto.js'
export type { SignedUrlConfig } from './security/SignedUrl.js'
export { SignedUrl } from './security/SignedUrl.js'

// ─── Decorators ─────────────────────────────────────────────

export { createLazyProxy, getLazyParams, Lazy } from './decorators/Lazy.js'
export {
  clearServiceRegistry,
  getServiceMetadata,
  getServiceRegistry,
  Inject,
  inject,
  Service,
} from './decorators/Service.js'

// ─── Router ─────────────────────────────────────────────────

export type {
  ControllerAction,
  MatchResult,
  ParamMatcher,
  RouteDefinition,
  RouteHandler,
  RouteHandlerFunction,
} from './router/Router.js'
export { GroupBuilder, matchers, OnRouteBuilder, RouteBuilder, Router } from './router/Router.js'

// ─── Middleware ──────────────────────────────────────────────

export type { MiddlewareFunction } from './middleware/Pipeline.js'
export { compose, MiddlewareRegistry } from './middleware/Pipeline.js'

// ─── HttpKernel ─────────────────────────────────────────────

export type { HttpKernelConfig } from './HttpKernel.js'
export { createHttpKernel } from './HttpKernel.js'

// ─── Server ─────────────────────────────────────────────────

export type {
  ErrorHandlerClass,
  LazyImport,
  MiddlewareClass,
  MiddlewareEntry,
} from './server/Server.js'
export { resolveMiddlewareEntry, Server } from './server/Server.js'

// ─── Ignitor ────────────────────────────────────────────────

export type { Command } from './console/CommandRunner.js'
export { CommandRunner } from './console/CommandRunner.js'
export type { AppEnvironment, HyperServerLike, IgnitorConfig, ReamrcConfig } from './Ignitor.js'
export { ConsoleKernel, defineConfig, Ignitor, prettyPrintError } from './Ignitor.js'

// ─── Providers ──────────────────────────────────────────────

export type { AppContext, ProviderContract } from './Provider.js'
export { Provider } from './Provider.js'

// ─── Codemods ───────────────────────────────────────────────

export type { Codemods } from './Codemods.js'
export { createCodemods } from './Codemods.js'

// ─── Errors ─────────────────────────────────────────────────

export type { ErrorEmitter, ErrorEvent, ErrorSeverity } from './ErrorBoundary.js'
export { ErrorBoundary } from './ErrorBoundary.js'
export { didYouMean, findClosestMatches, levenshtein } from './errors/FuzzyMatcher.js'
export {
  AtlasError,
  ContainerError,
  EventsError,
  ForgeError,
  PipelineError,
  RouterError,
  RuneError,
  WardenError,
} from './errors/ModuleErrors.js'
export type { PipelineStageName } from './errors/PipelineStageError.js'
export {
  createPipelineError,
  PIPELINE_STAGES,
  validatePipelineConfig,
} from './errors/PipelineStageError.js'
export { ReamError } from './errors/ReamError.js'

// ─── Utilities ──────────────────────────────────────────────

export type { ShutdownHandle, ShutdownOptions } from './GracefulShutdown.js'
export { installGracefulShutdown } from './GracefulShutdown.js'
export type { HealthChecker, HealthCheckResult, HealthStatus } from './HealthCheck.js'
export { HealthCheck } from './HealthCheck.js'
export type { HotReloadOptions } from './HotReload.js'
export { startHotReload } from './HotReload.js'

// ─── Types ──────────────────────────────────────────────────

export type {
  AsyncOrSync,
  Constructor,
  Dict,
  ExtractFunctions,
  InferRouteParams,
  OneOrMore,
  Opaque,
  Prettify,
  UnwrapOpaque,
} from './types/helpers.js'

// ─── Services ───────────────────────────────────────────────

export { setApp } from './services/app.js'
export { setRouter } from './services/router.js'
export { setServer } from './services/server.js'

// ─── Scheduler ──────────────────────────────────────────────

// ─── Events (event bus — ream core) ───
// Native-free surface only. The Rust-backed `EventsProvider` / `EventBus`
// (which load `events.<platform>.node` at import time) live on the
// `@c9up/ream/events` subpath so importing the main barrel stays lazy.
export type { EventsConfig } from './events/config.js'
export { defineConfig as defineEventsConfig } from './events/config.js'
export {
  BaseEvent,
  type ContainerResolver,
  Emitter,
  type ListenerClass,
} from './events/Emitter.js'
export type {
  ErrorReporter,
  LockBackend,
  RunTaskOutcome,
  ScheduleEvent,
  ScheduleEventSink,
  ScheduleInvocation,
  ScheduleMetadata,
  ScheduleProviderOptions,
  SchedulerOptions,
  ScheduleTaskCompletedEvent,
  ScheduleTaskFailedEvent,
  ScheduleTaskSkippedEvent,
  ScheduleTaskStartedEvent,
  TaskInfo,
  TaskStats,
} from './scheduler/index.js'
export {
  getScheduleMetadata,
  MemoryLockBackend,
  SCHEDULE_METADATA_KEY,
  Schedule,
  ScheduleProvider,
  Scheduler,
  StatsTracker,
} from './scheduler/index.js'

export const VERSION = '0.1.7'
