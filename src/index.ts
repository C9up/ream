/**
 * @module @c9up/ream
 * @description Ream — Rust-powered Node.js application framework
 * @implements FR11, FR12, FR13, FR14, FR16, FR17, FR18, FR19, FR20, FR21
 */

import 'reflect-metadata'

export { Application } from './Application.js'
export { SimpleConfigStore, defineConfig, env } from './ConfigLoader.js'
export { Container } from './container/Container.js'
export type { Binding, ServiceFactory, ServiceScope, ServiceToken } from './container/types.js'
export { Context } from './Context.js'
export type { AuthState } from './Context.js'
export { Inject, Service, clearServiceRegistry, getServiceMetadata, getServiceRegistry } from './decorators/Service.js'
export { Lazy, createLazyProxy, getLazyParams } from './decorators/Lazy.js'
export { ErrorBoundary } from './ErrorBoundary.js'
export type { ErrorEmitter, ErrorEvent, ErrorSeverity } from './ErrorBoundary.js'
export { ReamError } from './errors/ReamError.js'
export { HealthCheck } from './HealthCheck.js'
export type { HealthChecker, HealthCheckResult, HealthStatus } from './HealthCheck.js'
export { installGracefulShutdown } from './GracefulShutdown.js'
export type { ShutdownHandle, ShutdownOptions } from './GracefulShutdown.js'
export { startHotReload } from './HotReload.js'
export type { HotReloadOptions } from './HotReload.js'
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
export { createHttpKernel } from './HttpKernel.js'
export type { HttpKernelConfig } from './HttpKernel.js'
export { Ignitor } from './Ignitor.js'
export type { AppEnvironment, HyperServerLike, IgnitorConfig, ReamrcConfig } from './Ignitor.js'
export { MiddlewareRegistry, compose } from './middleware/Pipeline.js'
export type { MiddlewareFunction } from './middleware/Pipeline.js'
export { Provider } from './Provider.js'
export type { AppContext, ConfigStore } from './Provider.js'
export { Router, RouteBuilder } from './router/Router.js'
export type { MatchResult, RouteDefinition, RouteHandler } from './router/Router.js'

export const VERSION = '0.1.0'
