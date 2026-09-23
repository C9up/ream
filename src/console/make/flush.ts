/**
 * Turning rendered stubs into files on disk.
 *
 * Split from the commands because the rules are the same for one file and for
 * the three `make:module` emits, and they are not the obvious ones:
 *
 *   - A file that is already there is SKIPPED, not overwritten and not an
 *     error — Adonis' generators answer `SKIPPED:` and carry on, and `--force`
 *     is how one asks for the overwrite.
 *   - With `--force`, a failure half-way through puts back what the same run
 *     had already written. A generator that leaves a clobbered entity behind
 *     after failing on the controller is worse than one that writes nothing.
 *     That rollback is ours, not Adonis': its generators never overwrite more
 *     than one file per command.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

/** One file a generator intends to write. */
export interface PlannedFile {
  path: string
  content: string
  /** Was something already there? Answered while planning, not after. */
  exists: boolean
}

export interface FlushOptions {
  cwd: string
  dryRun: boolean
  force: boolean
}

/**
 * What a run did, in the shapes `--json` prints — see {@link outcomePayload}.
 */
export type FlushOutcome =
  | { status: 'planned'; files: PlannedFile[]; warnings: string[] }
  | {
      status: 'written'
      createdFiles: string[]
      modifiedFiles: string[]
      skippedFiles: string[]
      warnings: string[]
    }

/** `exists` is read now, not at write time: a plan describes one moment. */
export function plannedFile(destination: string, content: string, cwd: string): PlannedFile {
  return {
    path: destination,
    content,
    exists: fs.existsSync(path.resolve(cwd, destination)),
  }
}

export function flush(
  entries: readonly PlannedFile[],
  warnings: readonly string[],
  options: FlushOptions,
): FlushOutcome {
  if (options.dryRun) {
    return { status: 'planned', files: [...entries], warnings: [...warnings] }
  }

  const createdFiles: string[] = []
  const modifiedFiles: string[] = []
  const skippedFiles: string[] = []
  /** What each written path held before, so a later failure can put it back. */
  const rollbacks: Array<{ path: string; prior: Buffer | undefined }> = []

  try {
    for (const entry of entries) {
      if (entry.exists && !options.force) {
        skippedFiles.push(entry.path)
        continue
      }
      const target = path.resolve(options.cwd, entry.path)
      const prior = entry.exists ? fs.readFileSync(target) : undefined
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, entry.content)
      rollbacks.push({ path: target, prior })
      if (entry.exists) modifiedFiles.push(entry.path)
      else createdFiles.push(entry.path)
    }
  } catch (error) {
    rollback(rollbacks)
    throw error
  }

  return { status: 'written', createdFiles, modifiedFiles, skippedFiles, warnings: [...warnings] }
}

/**
 * Undo in reverse, and never throw: the caller is already reporting a failure,
 * and a rollback error on top of it buries the one that matters. What could not
 * be undone is named on stderr instead.
 */
function rollback(rollbacks: readonly { path: string; prior: Buffer | undefined }[]): void {
  for (const entry of [...rollbacks].reverse()) {
    try {
      if (entry.prior === undefined) fs.rmSync(entry.path, { force: true })
      else fs.writeFileSync(entry.path, entry.prior)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      process.stderr.write(`  rollback: failed to restore ${entry.path}: ${detail}\n`)
    }
  }
}

/**
 * The outcome as the JSON object `--json` prints, kept in one place because it
 * is a contract with another package rather than a debug dump: `ream-mcp` reads
 * the last line of stdout and dispatches on which shape it is.
 */
export function outcomePayload(outcome: FlushOutcome): Record<string, unknown> {
  if (outcome.status === 'planned') {
    return { files: outcome.files, warnings: outcome.warnings }
  }
  return {
    createdFiles: outcome.createdFiles,
    modifiedFiles: outcome.modifiedFiles,
    skippedFiles: outcome.skippedFiles,
    warnings: outcome.warnings,
  }
}
