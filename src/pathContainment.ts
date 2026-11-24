/**
 * Whether a file a generator is about to write stays inside the project.
 *
 * Checked on the link itself (`lstat`), not on what it points at: a link whose
 * target does not exist yet reads as "no file" to `existsSync`, and writing
 * through it creates that target wherever the link points — outside the
 * project, with a generated secret or source in it.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Whether something is at `filePath` (a dangling link counts). Never throws
 * for an absent path, so it is safe while only planning.
 */
export function pathPresent(filePath: string): boolean {
  try {
    fs.lstatSync(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * Whether a file is at `filePath`, after checking that writing there stays
 * inside `root`. Throws what `refuse` builds when the path is a link that
 * leads outside `root` or to nothing, or when its nearest existing directory
 * resolves outside `root`.
 */
export function existingInside(
  root: string,
  filePath: string,
  refuse: (reason: string) => Error,
): boolean {
  const canonRoot = fs.realpathSync(root)
  const inside = (canonical: string): boolean =>
    canonical === canonRoot || canonical.startsWith(canonRoot + path.sep)

  if (!pathPresent(filePath)) {
    // Nothing there: the directory it would be created in must not lead out.
    let ancestor = path.dirname(filePath)
    while (!pathPresent(ancestor) && path.dirname(ancestor) !== ancestor) {
      ancestor = path.dirname(ancestor)
    }
    if (!inside(realpathOrRefuse(ancestor, refuse))) {
      throw refuse('its directory resolves outside the project root')
    }
    return false
  }

  if (!inside(realpathOrRefuse(filePath, refuse))) {
    throw refuse('it resolves outside the project root')
  }
  return true
}

function realpathOrRefuse(filePath: string, refuse: (reason: string) => Error): string {
  try {
    return fs.realpathSync(filePath)
  } catch {
    // `lstat` saw something `realpath` cannot follow: a link to a path that
    // does not exist (or a loop). Writing through it creates the target.
    throw refuse('it is a symbolic link to a path that does not exist')
  }
}
