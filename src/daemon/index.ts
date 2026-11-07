/**
 * stdio entry point of the open-superagent daemon: it opens the Runtime (locking the state directory), registers the
 * orchestrator's MCP tools on a stdio server, starts the passes once the transport is connected, and stops cleanly on
 * SIGINT/SIGTERM. Port note: upstream ran inside a Cordis host with an HTTP panel; the ZCode plugin ships as this stdio
 * MCP daemon instead, and its state lives in one directory shared by nothing else.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Runtime, StateLocked } from './runtime.ts'
import { registerTools } from './tools.ts'

/** Where state lives: OPEN_SUPERAGENT_STATE_DIR wins, else the user's ~/.open-superagent. */
const stateDir = process.env.OPEN_SUPERAGENT_STATE_DIR || join(homedir(), '.open-superagent')

async function main(): Promise<void> {
  const runtime = await Runtime.open({ stateDir })
  await runtime.initialize()
  const server = new McpServer({ name: 'open-superagent', version: '0.1.0' })
  registerTools(server, runtime)
  await server.connect(new StdioServerTransport())
  // The passes run only once the server is up, so the first tick sees a started daemon and no trigger can arrive earlier.
  runtime.passes.start()
  const shutdown = (): void => {
    void runtime.stop().finally(() => process.exit(0))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

main().catch((error: unknown) => {
  process.stderr.write('open-superagent failed to start: ' + String(error) + '\n')
  // Exit code 3 names a lock conflict specifically, so a wrapper can tell "already running" from a real fault.
  process.exit(error instanceof StateLocked ? 3 : 1)
})
