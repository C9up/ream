/**
 * Pipeline Stage Error — indicates which pipeline stage failed.
 *
 * @implements FR73
 */

import { Exception } from '@c9up/flare'
import { E_PIPELINE_ERROR, E_PIPELINE_UNKNOWN_MIDDLEWARE } from './codes.js'

/**
 * Pipeline stage names in execution order.
 *
 * NOT an error code, despite living beside them — it is the list of stages, and
 * an application imports it by this name. The `E_` prefix belongs to codes
 * alone; a rename here breaks a public import for nothing.
 */
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

export type PipelineStageName = (typeof PIPELINE_STAGES)[number]

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
): E_PIPELINE_ERROR {
  const total = PIPELINE_STAGES.length
  const clampedIndex = Math.max(0, Math.min(stageIndex, total - 1))
  // The index is clamped into the list just above, so the lookup lands — the
  // fallback is what says so without asserting past the read.
  const stageName = PIPELINE_STAGES[clampedIndex] ?? '(unknown)'
  const position = `${clampedIndex + 1}/${total}`
  const nextStage = PIPELINE_STAGES[clampedIndex + 1] ?? '(end)'

  // The wrapped error's code stays the code: a framework error keeps saying
  // what it is, and only an error without one reads `E_PIPELINE_ERROR`.
  const code =
    originalError instanceof Exception && originalError.code !== undefined
      ? originalError.code
      : undefined
  return new E_PIPELINE_ERROR(originalError.message, {
    code,
    cause: originalError,
    pipelineStage: `${position} (${stageName})`,
    help: `Error occurred at pipeline stage ${position} (${stageName}). Next stage would have been: ${nextStage}.`,
    context: {
      ...context,
      stage: stageName,
      position,
      nextStage,
    },
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
}): E_PIPELINE_UNKNOWN_MIDDLEWARE[] {
  const errors: E_PIPELINE_UNKNOWN_MIDDLEWARE[] = []

  // Check named middleware references exist (deduplicated)
  if (config.routes && config.namedMiddleware) {
    const registered = new Set(Object.keys(config.namedMiddleware))
    const reported = new Set<string>()

    for (const route of config.routes) {
      for (const mw of route.middleware ?? []) {
        if (!registered.has(mw) && !reported.has(mw)) {
          reported.add(mw)
          errors.push(new E_PIPELINE_UNKNOWN_MIDDLEWARE(mw, [...registered].join(', ')))
        }
      }
    }
  }

  return errors
}
