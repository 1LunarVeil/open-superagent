/**
 * Fails the build when the worker agent's tool allowlist drifts from the daemon's real tool surface.
 *
 * Why this exists: a ZCode subagent sees only the tools its frontmatter lists, and MCP tools must be named in full
 * (`mcp__plugin_<plugin>_<server>__<tool>`). A rename in `plugin.json`, a typo in `agents/worker.md`, or a tool removed
 * from `tools.ts` silently leaves the worker unable to read or report — the loop then looks alive but completes nothing.
 * This script boots the built daemon, lists its tools over stdio, and checks every `mcp__…` entry in the agent files.
 *
 * Usage: node scripts/check-agent-tools.mjs   (run after `npm run build`)
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const manifest = JSON.parse(readFileSync(join(root, '.zcode-plugin', 'plugin.json'), 'utf8'))
const serverName = Object.keys(manifest.mcpServers ?? {})[0]
if (!serverName) fail('plugin.json declares no MCP server')

/** The host's visible name for one of this plugin's tools. */
const visible = tool => 'mcp__plugin_' + String(manifest.name).toLowerCase() + '_' + String(serverName).toLowerCase() + '__' + tool

/** A file of `agents/` and the `mcp__…` entries its frontmatter lists. */
function agentDeclarations() {
  const dir = join(root, 'agents')
  const files = readdirSync(dir).filter(name => name.endsWith('.md'))
  return files.map(file => {
    const text = readFileSync(join(dir, file), 'utf8')
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text)?.[1] ?? ''
    const toolsLine = /^tools:\s*(.*)$/mu.exec(frontmatter)?.[1] ?? ''
    const names = toolsLine.split(',').map(name => name.trim()).filter(name => name.startsWith('mcp__'))
    return { file, names }
  })
}

/** Prints the problem and exits non-zero. */
function fail(message) {
  process.stderr.write('check-agent-tools: ' + message + '\n')
  process.exit(1)
}

// A throwaway state directory keeps the check from touching real tickets.
const stateDir = join(root, '.agent-tools-check')
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, 'lib', 'daemon', 'index.js')],
  env: { ...process.env, OPEN_SUPERAGENT_STATE_DIR: stateDir },
})
const client = new Client({ name: 'check-agent-tools', version: '0.0.0' })
try {
  await client.connect(transport)
  const tools = new Set((await client.listTools()).tools.map(tool => tool.name))
  const problems = []
  for (const agent of agentDeclarations()) {
    for (const name of agent.names) {
      const bare = name.slice(name.lastIndexOf('__') + 2)
      if (!tools.has(bare)) problems.push(agent.file + ' lists ' + name + ' but the daemon exposes no tool named ' + bare)
      else if (name !== visible(bare)) problems.push(agent.file + ' lists ' + name + ' but the host will call it ' + visible(bare))
    }
    if (!agent.names.length) problems.push(agent.file + ' declares no MCP tools, so it cannot reach the daemon')
  }
  if (problems.length) {
    for (const problem of problems) process.stderr.write('check-agent-tools: ' + problem + '\n')
    process.exitCode = 1
  } else {
    process.stdout.write('check-agent-tools: OK (' + tools.size + ' daemon tools, ' + agentDeclarations().length + ' agent file(s))\n')
  }
} finally {
  await client.close().catch(() => undefined)
}
