# Governed Copilot SDK

A language-oriented governance sidecar for the GitHub Copilot SDK.

The first implementation targets Node.js and uses the published `@github/copilot-sdk` package as a dependency. Governance policy and evidence-ledger behavior live above the SDK through its public hooks, permissions, model selection, MCP, and session-event APIs.

## Try the sample

```powershell
cd nodejs
npm install
npm run build
npm install --prefix samples\governed-chat
npm start -- --config=samples/sample.governance.config.json
```

The sample loads the selected governance JSON and its adjacent `.env`, keeps one Copilot session, denies tools outside the active profile before execution, and writes hash-chained evidence to the configured ledger path.

## Layout

- `nodejs/` - Node.js implementation and package.
- `docs/` - shared design and usage documentation.

Rust is intentionally not part of the first implementation. A shared Rust core can be evaluated later if multiple language bindings require identical policy semantics.
