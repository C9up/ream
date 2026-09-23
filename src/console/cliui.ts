/**
 * Terminal UI — a thin re-export of `@c9up/lumen`.
 *
 * This file used to BE the implementation. It moved out because the framework
 * was not its only consumer: the Rust CLI, helix's reporter and every package
 * that prints a line all wanted the same `[ warn ]`, in the same yellow, and
 * none of them can depend on ream.
 *
 * Kept as a module rather than deleted so existing imports — `from
 * '../console/cliui.js'`, and `Logger`/`Ui` off the package barrel — keep
 * resolving.
 */

export {
  Action,
  Box,
  type CapturedLog,
  type Colors,
  ConsoleRenderer,
  Logger,
  type LoggerOptions,
  MemoryRenderer,
  type MessageOptions,
  type Renderer,
  Spinner,
  Steps,
  type StyleName,
  stripAnsi,
  Table,
  type TableCell,
  type TableChars,
  type TableInput,
  type TableOptions,
  type TableRow,
  Task,
  type TaskCallback,
  TaskContext,
  type TaskError,
  type TaskFailure,
  type TaskOutcome,
  type TaskResult,
  type TaskState,
  Tasks,
  type TasksOptions,
  Ui,
  type UiMode,
} from '@c9up/lumen'
