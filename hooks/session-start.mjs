/**
 * SessionStart hook of the open-superagent plugin: prints one line of JSON on stdout so the session knows the plugin is
 * present. It states availability only — it does not ask for a tick or claim any work, so a session whose tasks have
 * nothing to do with the daemon is not nudged toward it on every turn. Purely synchronous, dependency-free, and silent on
 * failure — a broken hook must never block session startup.
 */
try {
  process.stdout.write(JSON.stringify({
    systemMessage: 'open-superagent is available: superagent_status, superagent_tick, superagent_trigger_inject, and the'
      + ' rest of its tools are in this session. Use them when work should run as tracked tickets; the open-superagent'
      + ' skill describes the loop.',
  }) + '\n')
} catch {
  // Silent by design: the hook output is advisory only.
}
