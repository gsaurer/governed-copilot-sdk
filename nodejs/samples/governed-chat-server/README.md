# Governed chat server sample

This sample exposes a small HTTP and Server-Sent Events interface around `GovernedSession`. It is intended as a starting point for applications such as PDA that need to connect to a governed Copilot session over a messaging API.

Copilot runtime state is stored under `.copilot-state` beside the selected governance configuration. The HTTP server still keeps its session map in memory, so restarting it loses the API session registry and does not restore confidentiality state.

## Run

```powershell
cd nodejs\samples\governed-chat-server
npm install
npm start
```

Set `GOVERNANCE_CONFIG` to use another governance configuration. The default is the shared sample configuration:

```powershell
$env:GOVERNANCE_CONFIG = "..\sample.governance.config.json"
npm start
```

The server listens on `http://127.0.0.1:8120` by default. Set `PORT` to change the port.

## Endpoints

Create a session with its initial profile:

```http
POST /sessions
Content-Type: application/json

{"profile":"public"}
```

Send a prompt:

```http
POST /sessions/{sessionId}/messages
Content-Type: application/json

{"prompt":"What is the current session sensitivity?"}
```

Subscribe to filtered session events:

```http
GET /sessions/{sessionId}/events
```

The event stream includes assistant messages, reasoning events, tool starts, model changes, sensitivity upgrades, and errors. Delete a session with `DELETE /sessions/{sessionId}`. Use `GET /health` for a liveness check.

This sample has no authentication and is not suitable for network exposure. A production adapter must authenticate callers, authorize profile selection, protect SSE connections, limit request sizes, and avoid logging sensitive prompts or tool results.
