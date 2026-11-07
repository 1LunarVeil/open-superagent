/** Stdio smoke test: boots the built daemon as a real subprocess and exercises the MCP handshake and batch-1 tools. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { rmSync } from 'node:fs'

const stateDir = new URL('../.smoke-state/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
rmSync(stateDir, { recursive: true, force: true })

const transport = new StdioClientTransport({
  command: 'node',
  args: [new URL('../lib/daemon/index.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')],
  env: { ...process.env, OPEN_SUPERAGENT_STATE_DIR: stateDir },
})
const client = new Client({ name: 'open-superagent-smoke', version: '0.1.0' })
await client.connect(transport)

const tools = await client.listTools()
const names = tools.tools.map(tool => tool.name).sort()
console.log('TOOLS(' + names.length + '):', names.join(','))

const status = await client.callTool({ name: 'superagent_status', arguments: {} })
console.log('STATUS_OK:', status.content[0].text.includes('paused'))

// An unlisted sender is gate-ignored by default (observe-first admission): verify that, then allowlist alice.
const denied = await client.callTool({ name: 'superagent_trigger_inject', arguments: { threadId: 'smoke', actorId: 'stranger', text: 'Unlisted request.', human: true, addressed: 'mention' } })
console.log('INJECT_STORED:', denied.content[0].text.includes('stored'))
const deniedTick = await client.callTool({ name: 'superagent_tick', arguments: {} })
console.log('UNLISTED_NO_CANDIDATE:', !deniedTick.content[0].text.includes('assess_candidate'))

const allow = await client.callTool({ name: 'superagent_settings_save', arguments: { block: 'policy', value: { sources: { manual: { allowed: [{ id: 'alice', name: 'Alice' }] } } } } })
console.log('ALLOWLIST_SAVED:', allow.content[0].text.slice(0, 160).replace(/\n/g, ' '))

const inject = await client.callTool({ name: 'superagent_trigger_inject', arguments: { threadId: 'smoke', actorId: 'alice', text: 'Please fix the typo in the README.', human: true, addressed: 'mention' } })
console.log('INJECT:', inject.content[0].text.slice(0, 120))

const tick = await client.callTool({ name: 'superagent_tick', arguments: {} })
const tickText = tick.content[0].text
console.log('TICK_HAS_CANDIDATE:', tickText.includes('assess_candidate'))

await client.close()
rmSync(stateDir, { recursive: true, force: true })
console.log('SMOKE_DONE')
