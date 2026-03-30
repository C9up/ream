/**
 * Pipeline Stage Error — indicates which pipeline stage failed.
 *
 * @implements FR73
 */

import { ReamError } from './ReamError.js'

/** Pipeline stage names in execution order. */
export const PIPELINE_STAGES = [
  'Security (Blackhole)',
  'Logging',
  'Global Middleware',
  'Named Middleware',
  'Guard',
  'Validate',
  'Transaction',
  'Handler',
  'After Middleware',
  'Response Logging',
] as const

export type PipelineStageName = typeof PIPELINE_STAGES[number]

/**
 * Create a pipeline stage error with position context.
 *
 * @param stageIndex - Zero-based index in PIPELINE_STAGES (clamped to valid range)
 * @param originalError - The error that occurred
 * @param context - Additional context
 */
export function createPipelineError(
  stageIndex: number,
  originalError: Error,
  context?: Record<string, string>,
): ReamError {
  const total = PIPELINE_STAGES.length
  const clampedIndex = Math.max(0, Math.min(stageIndex, total - 1))
  const stageName = PIPELINE_STAGES[clampedIndex]
  const position = `${clampedIndex + 1}/${total}`
  const nextStage = clampedIndex + 1 < total ? PIPELINE_STAGES[clampedIndex + 1] : '(end)'

  const errorCode = originalError instanceof ReamError
    ? originalError.code
    : 'PIPELINE_ERROR'

  return new ReamError(errorCode, originalError.message, {
    pipelineStage: `${position} (${stageName})`,
    hint: `Error occurred at pipeline stage ${position} (${stageName}). Next stage would have been: ${nextStage}.`,
    context: {
      ...context,
      stage: stageName,
      position,
      nextStage,
    },
    sourceFile: originalError instanceof ReamError ? originalError.sourceFile : undefined,
    sourceLine: originalError instanceof ReamError ? originalError.sourceLine : undefined,
    docsUrl: originalError instanceof ReamError ? originalError.docsUrl : undefined,
  })
}

/**
 * Validate pipeline configuration at boot time.
 * Detects misconfiguration before accepting traffic.
 *
 * @implements FR74
 */
export function validatePipelineConfig(config: {
  globalMiddleware?: unknown[]
  namedMiddleware?: Record<string, unknown>
  routes?: Array<{ middleware?: string[] }>
}): ReamError[] {
  const errors: ReamError[] = []

  // Check named middleware references exist (deduplicated)
  if (config.routes && config.namedMiddleware) {
    const registered = new Set(Object.keys(config.namedMiddleware))
    const reported = new Set<string>()

    for (const route of config.routes) {
      for (const mw of route.middleware ?? []) {
        if (!registered.has(mw) && !reported.has(mw)) {
          reported.add(mw)
          errors.push(new ReamError('PIPELINE_UNKNOWN_MIDDLEWARE', `Middleware '${mw}' is not registered`, {
            hint: `Register it with middleware.register('${mw}', handler) before using it on routes.`,
            context: {
              middleware: mw,
              registered: [...registered].join(', '),
            },
          }))
        }
      }
    }
  }

  return errors
}
