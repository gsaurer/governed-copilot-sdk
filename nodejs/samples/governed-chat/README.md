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

The sample requires an installed Copilot CLI and normal Copilot authentication.
