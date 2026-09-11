# Governed Copilot SDK

A language-oriented governance sidecar for the GitHub Copilot SDK.

The first implementation targets Node.js and uses the published `@github/copilot-sdk` package as a dependency. Governance policy and evidence-ledger behavior live above the SDK through its public hooks, permissions, model selection, MCP, and session-event APIs.

## Prerequisites

- Node.js 22 or later.
- GitHub Copilot CLI installed and authenticated with an account that has Copilot access.

Run `copilot --version` and `copilot` before starting the sample if authentication has not already been completed.

## Get started

```powershell
cd nodejs
npm install
npm run build
npm install --prefix samples\governed-chat
npm start -- --config=samples/sample.governance.config.json --info
```

The chat starts in the `public` profile. It loads [nodejs/samples/sample.governance.config.json](nodejs/samples/sample.governance.config.json), starts the configured `internal-data` MCP server, and writes Copilot state plus hash-chained governance evidence under `nodejs/samples/.copilot-state`.

For Azure Foundry configurations, copy [nodejs/samples/.env.sample](nodejs/samples/.env.sample) to `nodejs/samples/.env` and provide the required values. Do not commit that file.

## Guided chat example

Paste this into governed chat:

```text
Search internal documents for the Northwind escalation. Then use web search to find recent competitor authentication-reliability announcements and draft customer talking points using the escalation details.
```

The synthetic MCP result includes a customer escalation and an embargoed product announcement, labelled `confidential`. Governance upgrades the chat with `reason=classified-tool-result`. The `confidential` profile allows the internal-data MCP tools but not `builtin:web_search`, so an attempted public research handoff is denied before execution. Start a new chat session after changing MCP configuration or policy.

See [nodejs/samples/governed-chat/README.md](nodejs/samples/governed-chat/README.md) for console options and [nodejs/samples/governed-chat-server/README.md](nodejs/samples/governed-chat-server/README.md) for the HTTP/SSE sample.

## Layout

- `nodejs/` - Node.js implementation and package.
- `docs/` - shared design and usage documentation.

Rust is intentionally not part of the first implementation. A shared Rust core can be evaluated later if multiple language bindings require identical policy semantics.
