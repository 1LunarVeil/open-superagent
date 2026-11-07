/**
 * SessionStart hook of the open-superagent plugin: prints one line of JSON on stdout so the session
 * sees a system message pointing at the tick loop. Purely synchronous, dependency-free, and silent
 * on failure — a broken hook must never block session startup, so every error is swallowed and the
 * process still exits 0.
 */
try {
  process.stdout.write(JSON.stringify({
    systemMessage: 'open-superagent is available. Call superagent_tick to pick up pending orchestrator actions; after'
      + ' handling a batch, call superagent_tick_ack with the actionIds you finished.',
  }) + '\n')
} catch {
  // Silent by design: the hook output is advisory only.
}
