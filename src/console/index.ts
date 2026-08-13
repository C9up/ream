/**
 * `@c9up/ream/ace` — the console command surface.
 *
 * Mirrors Ace's import path so a command reads the same way it does in Adonis:
 *
 *   import { BaseCommand, args, flags } from '@c9up/ream/ace'
 */

export type { AceOptions } from './Ace.js'
export { Ace } from './Ace.js'
export { BaseCommand } from './BaseCommand.js'
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
