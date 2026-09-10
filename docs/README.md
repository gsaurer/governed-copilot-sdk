# Governed Copilot SDK

This repository adds governance beside the published GitHub Copilot SDK.

## Design

The underlying SDK owns model execution, tools, MCP, permissions, hooks, and session events. This project owns:

- sensitivity profiles and monotonic upgrades;
- model, tool, and MCP policy decisions;
- pre-execution enforcement through SDK hooks;
- append-only evidence recording;
- local or remote ledger implementations.

A governance wrapper should keep one Copilot session so conversation context is preserved. A sensitivity upgrade changes the active policy and model through the existing session APIs; it should not create a replacement session.

## Initial implementation

The first implementation targets Node.js and depends on `@github/copilot-sdk`. 