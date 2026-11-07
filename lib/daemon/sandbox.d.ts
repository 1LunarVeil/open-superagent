/** Thrown when a ticket workspace could not be prepared; the launch handler turns it into a `failed` report. */
export declare class PrepareFailed extends Error {
    constructor(message: string);
}
/** What the executor needs to prepare a workspace. */
export interface PrepareOptions {
    /** The ticket directory to create; it must be absolute and inside `workRoot`. */
    directory: string;
    /** Root the ticket directory must stay inside, normally `<stateDir>/work` or the configured executor directory. */
    workRoot: string;
    /** Whether to create the directory as a detached git worktree. */
    worktree: boolean;
    /** The project repository, or undefined when the host supplied none. */
    projectDir?: string;
    /** The base ref the worktree starts from; defaults to `HEAD`. */
    ref?: string;
    /** How long worktree creation may run, in milliseconds. */
    timeoutMs: number;
}
/**
 * True when `directory` is an absolute path that resolves inside `root` and contains no `..` segment.
 * The check runs on resolved paths, so symlink-free normalization cannot escape the root by prefix tricks.
 */
export declare function insideRoot(directory: string, root: string): boolean;
/**
 * Prepares `options.directory` for the ticket. An existing directory that already holds a work tree counts as prepared, so
 * a resumed ticket keeps its work; otherwise the directory becomes a detached worktree of the project repository, or an
 * empty directory when the project is not a git work tree or worktrees are disabled.
 * @throws PrepareFailed when preparation fails.
 */
export declare function prepareWorkspace(options: PrepareOptions): Promise<string[]>;
/** Removes a ticket workspace when the plugin created it as a worktree of `projectDir`; a dirty one stays for the person. */
export declare function releaseWorkspace(directory: string, projectDir?: string): Promise<void>;
/** The separator-safe check other modules use to describe a ticket directory in a prompt. */
export declare const pathSeparator: "/" | "\\";
