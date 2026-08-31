/**
 * @module @c9up/ream
 * @description Ream — Rust-powered Node.js application framework
 * @implements FR11, FR12, FR13, FR14, FR16, FR17, FR18, FR19, FR20, FR21
 */

import 'reflect-metadata'

// ─── Core ───────────────────────────────────────────────────

export type { AppEnvironment, ApplicationMode, ApplicationState } from './Application.js'
export { Application } from './Application.js'
export { ConfigStore, configProvider, defineModuleConfig, env } from './ConfigLoader.js'
export { Container } from './container/Container.js'
export { ContainerResolver } from './container/ContainerResolver.js'
export { ContextualBindingsBuilder } from './container/ContextualBindingsBuilder.js'
export type { Binding, ServiceFactory, ServiceScope, ServiceToken } from './container/types.js'
export { type DirectoriesNode, directories } from './directories.js'
export { Env, EnvValidationException } from './env/Env.js'
export { loadEnvFiles } from './env/loadEnvFiles.js'
export { Secret } from './env/Secret.js'
export {
  EnvVarError,
  type OptionalCondition,
  type RequiredNode,
  type SchemaFnOptions,
  type SchemaNode,
  type StringOptions,
} from './env/schema.js'
export { MigrationRegistry } from './migrations/MigrationRegistry.js'
export type {
  MigrationRunnerContract,
  MigrationState,
  MigrationStatusNode,
  RegisteredMigrationSource,
} from './migrations/types.js'

// ─── HTTP (new — AdonisJS-compatible) ───────────────────────

export {
  createError,
  E_FORBIDDEN,
  E_HTTP_EXCEPTION,
  E_HTTP_REQUEST_ABORTED,
  E_ROUTE_NOT_FOUND,
  E_ROW_NOT_FOUND,
  E_UNAUTHORIZED,
  E_VALIDATION_ERROR,
  Exception,
  type ExceptionClass,
  type ExceptionConstructor,
  ExceptionHandler,
  type HttpError,
  InvalidArgumentsException,
  RuntimeException,
  type StatusPageRenderer,
} from './http/Exception.js'
export type { Authorizer, AuthState, RouteInfo } from './http/HttpContext.js'
export { HttpContext } from './http/HttpContext.js'
export { RedirectBuilder } from './http/RedirectBuilder.js'
export type { RawRequest } from './http/Request.js'
export { Request } from './http/Request.js'
export { Response } from './http/Response.js'
export type { SseStreamOptions } from './http/SseStream.js'
export { SseStream } from './http/SseStream.js'
export { type GetterFn, Macroable, type MacroFn } from './utils/Macroable.js'

// ─── Session ────────────────────────────────────────────────

export { CookieDriver as SessionCookieDriver } from './session/drivers/CookieDriver.js'
export type {
  DatabaseDriverOptions as SessionDatabaseDriverOptions,
  SessionDbConnection,
} from './session/drivers/DatabaseDriver.js'
export { DatabaseDriver as SessionDatabaseDriver } from './session/drivers/DatabaseDriver.js'
export type { FileDriverOptions as SessionFileDriverOptions } from './session/drivers/FileDriver.js'
export { FileDriver as SessionFileDriver } from './session/drivers/FileDriver.js'
export { MemoryDriver as SessionMemoryDriver } from './session/drivers/MemoryDriver.js'
export type {
  RedisSessionOptions,
  SessionRedisClient,
  SessionRedisClientSource,
} from './session/drivers/RedisDriver.js'
export { RedisDriver as SessionRedisDriver } from './session/drivers/RedisDriver.js'
export {
  E_SESSION_NOT_READY,
  E_SESSION_TAGGING_NOT_SUPPORTED,
} from './session/errors.js'
export type { ValuePath } from './session/ReadOnlyValuesStore.js'
export { ReadOnlyValuesStore } from './session/ReadOnlyValuesStore.js'
export type {
  SessionConfig,
  SessionDriver,
  SessionDriverWithTagging,
  TaggedSession,
} from './session/Session.js'
export { Session, supportsTagging as sessionStoreSupportsTagging } from './session/Session.js'
export { default as SessionMiddleware } from './session/SessionMiddleware.js'

// ─── Body Parser ────────────────────────────────────────────

export type { BodyParserConfig } from './bodyparser/BodyParserMiddleware.js'
export { default as BodyParserMiddleware } from './bodyparser/BodyParserMiddleware.js'
export type { FileValidationOptions } from './bodyparser/MultipartFile.js'
export { MultipartFile } from './bodyparser/MultipartFile.js'

// ─── JSON-RPC ───────────────────────────────────────────────

// JSON-RPC is opt-in and pulls the optional @c9up/comet peer, so it is NOT
// re-exported from the core barrel — import it from the subpaths instead:
//   '@c9up/ream/rpc/provider' → RpcProvider, RpcConfig, RpcProviderOptions
//   '@c9up/ream/rpc/router'   → RpcRouter, RpcMethodBuilder, RpcHandler, RpcMethodDefinition

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
export {
  CookieSigner,
  E_INSECURE_APP_KEY,
  E_MISSING_APP_KEY,
} from './security/CookieSigner.js'
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
  SignedUrlOptions,
} from './router/Router.js'
export {
  GroupBuilder,
  matchers,
  OnRouteBuilder,
  RouteBuilder,
  RouteResource,
  Router,
  UrlBuilder,
} from './router/Router.js'

// ─── Middleware ──────────────────────────────────────────────

export type { MiddlewareFunction } from './middleware/Pipeline.js'
export { composeMiddleware, MiddlewareRegistry } from './middleware/Pipeline.js'

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

export { BaseCommand } from './console/BaseCommand.js'
export { Logger, Ui } from './console/cliui.js'
export { args, flags } from './console/decorators.js'
// Renamed at the root: Ream already exports an HTTP `ExceptionHandler`, and
// two different things under one name is worse than a longer one. It keeps its
// Console name on the console entry point.
export { ExceptionHandler as ConsoleExceptionHandler } from './console/ExceptionHandler.js'
export { default as HelpCommand } from './console/HelpCommand.js'
export { IndexGenerator } from './console/IndexGenerator.js'
export { Kernel } from './console/Kernel.js'
export { default as ListCommand } from './console/ListCommand.js'
export { FsLoader, ListLoader } from './console/loaders.js'
export { Parser } from './console/parser.js'
export { Prompt, PromptTrap } from './console/prompts.js'
export type {
  ArgumentMetaData,
  CommandClass,
  CommandInstance,
  CommandOptions,
  FlagMetaData,
} from './console/types.js'
export type {
  HyperServerLike,
  IgnitorConfig,
  ReamrcConfig,
  TestSuiteConfig,
  TestsConfig,
} from './Ignitor.js'
export { ConsoleKernel, defineConfig, Ignitor, prettyPrintError } from './Ignitor.js'

// ─── Providers ──────────────────────────────────────────────

export { errors } from './errors/aggregate.js'
export type { AppContext, ProviderContract } from './Provider.js'
export { Provider } from './Provider.js'
export type {
  AuthenticatorName,
  Authenticators,
  ContainerBinding,
  ContainerBindings,
} from './types/index.js'

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
export { isReamError, ReamError } from './errors/ReamError.js'

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
export type {
  AsyncUnsubscribeFunction,
  UnsubscribeFunction,
} from './events/Emitter.js'
export {
  BaseEvent,
  Emitter,
  type EmitterResolver,
  type ListenerClass,
} from './events/Emitter.js'
export {
  type BufferedEvent,
  type BufferedEventName,
  type EventFinder,
  EventsBuffer,
} from './events/EventsBuffer.js'
export type {
  ErrorReporter,
  LockBackend,
  LockBackendFactory,
  LockRedisClient,
  LockRedisResolver,
  RunTaskOutcome,
  ScheduleEvent,
  ScheduleEventSink,
  ScheduleInvocation,
  ScheduleMetadata,
  ScheduleProviderOptions,
  SchedulerConfig,
  SchedulerOptions,
  ScheduleTaskCompletedEvent,
  ScheduleTaskFailedEvent,
  ScheduleTaskSkippedEvent,
  ScheduleTaskStartedEvent,
  TaskInfo,
  TaskStats,
} from './scheduler/index.js'
export {
  defineSchedulerConfig,
  getScheduleMetadata,
  locks,
  MemoryLockBackend,
  RedisLockBackend,
  SCHEDULE_METADATA_KEY,
  Schedule,
  ScheduleProvider,
  Scheduler,
  StatsTracker,
} from './scheduler/index.js'

export const VERSION = '0.2.13'
