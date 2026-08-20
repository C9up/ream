/**
 * `@c9up/ream/console` — the console command surface.
 *
 * The SDK is ours — only the shape is borrowed: a command declares its name,
 * its args and its flags, then runs.
 *
 *   import { BaseCommand, args, flags } from '@c9up/ream/console'
 */

export { BaseCommand } from './BaseCommand.js'
export type { ConsoleOptions } from './Console.js'
export { Console } from './Console.js'
export type { Colors, StyleName, TaskOutcome } from './cliui.js'
export {
  Action,
  Box,
  Logger,
  Table,
  TaskContext,
  Tasks,
  Ui,
} from './cliui.js'
export type { ArgumentOptions, FlagOptions } from './decorators.js'
export { args, flags } from './decorators.js'
export { ExceptionHandler } from './ExceptionHandler.js'
export { default as HelpCommand } from './HelpCommand.js'
export type { CommandsManifest } from './IndexGenerator.js'
export { IndexGenerator } from './IndexGenerator.js'
export type {
  CommandExecutor,
  CommandLoader,
  ErrorRenderer,
  GlobalFlagListener,
  HandleResult,
  KernelOptions,
  KernelState,
} from './Kernel.js'
export { Kernel, serializeCommand } from './Kernel.js'
export { default as ListCommand } from './ListCommand.js'
export { FsLoader, ListLoader } from './loaders.js'
export type { ParseOptions } from './parser.js'
export { Parser, parseArgv } from './parser.js'
export type {
  BooleanPromptOptions,
  MultiplePromptOptions,
  PromptChoice,
  PromptOptions,
  SelectPromptOptions,
} from './prompts.js'
export { Prompt, PromptTrap } from './prompts.js'
export { commandExec } from './tracing.js'
export type {
  ArgumentMetaData,
  CommandClass,
  CommandInstance,
  CommandOptions,
  ExecutedCommand,
  FlagMetaData,
  ParsedInput,
} from './types.js'
export { isCommandClass } from './types.js'
export {
  renderErrorWithSuggestions,
  sortAlphabetically,
  validateCommand,
  validateCommandMetaData,
} from './utils.js'
