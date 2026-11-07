/**
 * stdio entry point of the open-superagent daemon: it opens the Runtime (locking the state directory), registers the
 * orchestrator's MCP tools on a stdio server, starts the passes once the transport is connected, and stops cleanly on
 * SIGINT/SIGTERM. Port note: upstream ran inside a Cordis host with an HTTP panel; the ZCode plugin ships as this stdio
 * MCP daemon.
 *
 * State is per project, not per user: a daemon's domain state is one repository's tickets, and a single global store
 * would mix two repositories' work and serialize them behind one lock. `OPEN_SUPERAGENT_STATE_DIR` still wins for tests
 * and non-ZCode hosts.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Runtime, StateLocked } from './runtime.ts'
import { registerTools } from './tools.ts'

/** The plugin's own package version, so the MCP handshake never drifts from the manifest. */
function packageVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** The project the tickets belong to: the host's workspace, else the process working directory. */
const projectDir = resolve(process.env.OPEN_SUPERAGENT_PROJECT_DIR || process.env.ZCODE_PROJECT_DIR || process.cwd())

/**
 * Where state lives: an explicit `OPEN_SUPERAGENT_STATE_DIR`, else a directory per project under `~/.open-superagent`.
 * A pre-isolation global database at `~/.open-superagent` is inherited only when it actually holds work: an empty legacy
 * file (created by an earlier build that never saw a trigger) must not make every project share one directory again.
 */
function resolveStateDir(): string {
  const explicit = process.env.OPEN_SUPERAGENT_STATE_DIR
  if (explicit) return explicit
  const root = join(homedir(), '.open-superagent')
  const legacy = join(root, 'open-superagent.sqlite')
  if (existsSync(legacy) && legacyHasWork(legacy)) return root
  // Windows paths are case-insensitive and use either separator, so normalize before hashing. This is a directory name,
  // not a security control, but the digest is still SHA-256: one algorithm everywhere, and no weak-hash lint.
  const identity = createHash('sha256').update(projectDir.toLowerCase().replace(/\\/g, '/')).digest('hex').slice(0, 16)
  return join(root, 'projects', identity)
}

/** True when a legacy database holds at least one trigger or ticket, so an upgrade would lose something by not reusing it. */
function legacyHasWork(path: string): boolean {
  try {
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      const row = db.prepare('SELECT (SELECT COUNT(*) FROM trigger) + (SELECT COUNT(*) FROM ticket) AS n').get()
      return Number(row?.n ?? 0) > 0
    } finally {
      db.close()
    }
  } catch {
    // Unreadable or not a database yet: a per-project directory is the safer choice, and the old file stays untouched.
    return false
  }
}

const stateDir = resolveStateDir()

async function main(): Promise<void> {
  const runtime = await Runtime.open({ stateDir, projectDir })
  try {
    await runtime.initialize()
  } catch (error) {
    // A failure after the directory lock was taken must release it; otherwise the next session reports "another daemon
    // already owns…", which is worse than the original error.
    await runtime.stop().catch(() => undefined)
    throw error
  }
  const server = new McpServer({ name: 'open-superagent', version: packageVersion() })
  registerTools(server, runtime)
  await server.connect(new StdioServerTransport())
  // The passes run only once the server is up, so the first tick sees a started daemon and no trigger can arrive earlier.
  runtime.passes.start()
  let stopping = false
  const shutdown = (): void => {
    // The host closes the transport and then may kill the process; the lock and the database must still be released, or
    // the next session in this project fails to start. Run once, and stay alive only until the shutdown finishes.
    if (stopping) return
    stopping = true
    void runtime.stop().finally(() => process.exit(0))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  // A stdio MCP client signals "done" by closing the pipe, which raises no signal: without this the process lingers, the
  // state lock is never released, and reopening the same project fails with exit 3 until the stale window lapses.
  process.stdin.once('end', shutdown)
  process.stdin.once('close', shutdown)
  // Do not let an early exit leave the directory locked: cover the transport closing from the server side too.
  server.server.onclose = shutdown
}

main().catch((error: unknown) => {
  if (error instanceof StateLocked) {
    // A second session in the same project shares this state directory; only one daemon may own it.
    process.stderr.write('open-superagent: another daemon already owns ' + stateDir
      + '. Close the other session in this project, or set OPEN_SUPERAGENT_STATE_DIR to a separate directory.\n')
    process.exit(3)
  }
  process.stderr.write('open-superagent failed to start: ' + String(error) + '\n')
  process.exit(1)
})
