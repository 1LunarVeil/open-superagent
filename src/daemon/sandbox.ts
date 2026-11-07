/**
 * Ticket workspace preparation: the one place that turns an accepted ticket into a directory a worker can edit.
 *
 * Upstream left this entirely to an operator-configured `executor.prepare` shell command. This port deliberately does not
 * execute an arbitrary command string: the only program it ever runs is `git`, with a fixed argument vector, and every
 * value that reaches that vector is validated first (absolute path, no `..`, inside the configured work root; base ref
 * matched against a strict pattern). A ticket directory or ref can therefore never be read as command syntax.
 *
 * A failed preparation fails the ticket instead of retrying, because an existing directory would otherwise count as
 * prepared and a retry would treat leftovers as a workspace (the same reasoning as upstream's `PrepareFailed`).
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** A git base ref that is safe as one argument: no leading dash, no path traversal, no whitespace, no shell metacharacters. */
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/

/** Thrown when a ticket workspace could not be prepared; the launch handler turns it into a `failed` report. */
export class PrepareFailed extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PrepareFailed'
  }
}

/** What the executor needs to prepare a workspace. */
export interface PrepareOptions {
  /** The ticket directory to create; it must be absolute and inside `workRoot`. */
  directory: string
  /** Root the ticket directory must stay inside, normally `<stateDir>/work` or the configured executor directory. */
  workRoot: string
  /** Whether to create the directory as a detached git worktree. */
  worktree: boolean
  /** The project repository, or undefined when the host supplied none. */
  projectDir?: string
  /** The base ref the worktree starts from; defaults to `HEAD`. */
  ref?: string
  /** How long worktree creation may run, in milliseconds. */
  timeoutMs: number
}

/** True when `path` is a git work tree (a `.git` entry exists at its root). */
function isWorkTree(path: string): boolean {
  return existsSync(join(path, '.git'))
}

/**
 * True when `directory` is an absolute path that resolves inside `root` and contains no `..` segment.
 * The check runs on resolved paths, so symlink-free normalization cannot escape the root by prefix tricks.
 */
export function insideRoot(directory: string, root: string): boolean {
  if (!isAbsolute(directory) || directory.includes('..')) return false
  const target = resolve(directory), base = resolve(root)
  if (target === base) return false
  const rel = relative(base, target)
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Validate the workspace inputs once, so no later call can hand git an unexpected argument. */
function check(options: PrepareOptions): void {
  if (!insideRoot(options.directory, options.workRoot))
    throw new PrepareFailed('The ticket directory must be an absolute path inside the work root')
  const ref = options.ref?.trim() || 'HEAD'
  if (!REF_PATTERN.test(ref) || ref.includes('..'))
    throw new PrepareFailed('The worktree base ref is not a plain git ref name')
}

/**
 * Creates a detached worktree of `projectDir` at `directory` with a fixed argument vector.
 * Detached HEAD keeps tickets independent: no branch is created, so concurrent tickets never fight over a name.
 * @throws PrepareFailed with git's output when the worktree cannot be created.
 */
async function addWorktree(projectDir: string, directory: string, ref: string, timeoutMs: number): Promise<void> {
  try {
    // The `--` separator ends git's option parsing, so neither value can be read as a flag.
    await execFileAsync('git', ['worktree', 'add', '--detach', '--', directory, ref],
      { cwd: projectDir, timeout: timeoutMs, windowsHide: true })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new PrepareFailed('Creating the ticket worktree failed: ' + detail.slice(0, 800))
  }
}

/** Removes a worktree of `projectDir`, ignoring a dirty one (git refuses without --force) and any error. */
async function removeWorktree(projectDir: string, directory: string): Promise<void> {
  const args = ['worktree', 'remove']
  if (!directory.includes('..')) args.push('--', directory)
  else return
  await execFileAsync('git', args, { cwd: projectDir, timeout: 60_000, windowsHide: true }).catch(() => undefined)
}

/**
 * Prepares `options.directory` for the ticket. An existing directory that already holds a work tree counts as prepared, so
 * a resumed ticket keeps its work; otherwise the directory becomes a detached worktree of the project repository, or an
 * empty directory when the project is not a git work tree or worktrees are disabled.
 * @throws PrepareFailed when preparation fails.
 */
export async function prepareWorkspace(options: PrepareOptions): Promise<string[]> {
  check(options)
  const { directory, worktree, projectDir } = options
  const notes: string[] = []
  if (existsSync(directory) && statSync(directory).isDirectory() && isWorkTree(directory)) return notes
  if (existsSync(directory) && statSync(directory).isDirectory()) {
    // An empty leftover directory is removed so the worktree can own the path; anything with content stays untouched.
    try { rmSync(directory, { recursive: false }) } catch { /* Not empty: keep it; git refuses a non-empty target anyway. */ }
  }
  if (!worktree || !projectDir || !isWorkTree(projectDir)) {
    // Nothing to check out: the worker starts in an empty directory, as upstream does without a prepare command. The
    // directory still has to exist, because the worker prompt names it and a subagent cannot create its own workspace.
    mkdirSync(directory, { recursive: true })
    notes.push(projectDir ? 'The project directory is not a git work tree; the ticket has an empty workspace.' : 'No project directory was supplied; the ticket has an empty workspace.')
    return notes
  }
  await addWorktree(projectDir, directory, options.ref?.trim() || 'HEAD', options.timeoutMs)
  notes.push('The ticket workspace is a detached git worktree of the project repository.')
  return notes
}

/** Removes a ticket workspace when the plugin created it as a worktree of `projectDir`; a dirty one stays for the person. */
export async function releaseWorkspace(directory: string, projectDir?: string): Promise<void> {
  if (!projectDir || directory.includes('..') || !isWorkTree(projectDir) || !existsSync(directory)) return
  await removeWorktree(projectDir, directory)
}

/** The separator-safe check other modules use to describe a ticket directory in a prompt. */
export const pathSeparator = sep
