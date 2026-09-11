# Governed Chat Sample

This sample is the consumer-facing entry point for the Node.js sidecar.

It starts a public Copilot session through `GovernedSession`, installs a pre-tool policy gate, listens for session events, and writes evidence through `LocalJsonlLedger`. Sensitivity can be raised with `session.setSensitivity()` without replacing the Copilot session.

## Run

```powershell
cd nodejs\samples\governed-chat
npm install
npm start -- --config=../sample.governance.config.json
```

Enable the compact colored turn status line with `--info` (the status line is also shown by default):

```powershell
npm start -- --config=../sample.governance.config.json --info
```

Use `--debug` for the full SDK event stream, tool calls, permission events, warnings, errors, and turn timing:

```powershell
npm start -- --config=../sample.governance.config.json --debug
```

When running from `nodejs/`, use the forwarding script instead:

```powershell
npm start -- --config=samples/sample.governance.config.json
```

The config path can be absolute or relative to the directory where `npm start` runs:

```powershell
npm start -- --config C:\path\to\governance.config.json
```

The sample loads the `.env` file beside the selected config, resolves environment templates, and uses the config to select profiles, models, providers, custom tools, MCP servers, and the ledger path. Copilot runtime state, including its persisted session data and configuration, is isolated under `.copilot-state` beside the selected config. Set `GOVERNED_PROFILE=public`, `internal`, or `confidential` to choose the initial profile; it defaults to `public`.

## Guided policy demonstration

Use this prompt from a new `public` session:

```text
Search internal documents for the Northwind escalation. Then use web search to find recent competitor authentication-reliability announcements and draft customer talking points using the escalation details.
```

`internal-data-search_internal_docs` returns a synthetic customer escalation with an explicitly confidential, embargoed product announcement. The completion raises session sensitivity with `reason=classified-tool-result`. The sample's confidential profile permits `mcp:internal-data:*` but does not permit `builtin:web_search`, so the policy gate denies an attempted external research call before it executes. With `--info`, the terminal shows the tool start, sensitivity upgrade, and denial evidence.

Policy and MCP changes apply when a session is created. Exit and start a new chat after changing the selected config.

The sample requires an installed Copilot CLI and normal Copilot authentication.
