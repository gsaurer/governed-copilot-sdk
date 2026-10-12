# Tool search for the Copilot SDK

This article describes the tool-search capability exposed through governed sessions. Tool search lets an agent discover tools on demand instead of loading every tool definition into every turn, and keeps search results bounded by the same policy that governs execution.

## Summary

Applications that register many MCP servers or custom tools pay a recurring prompt-size cost: every tool's name, description, and JSON schema is sent to the model on every turn, whether or not that turn needs it. The underlying `@github/copilot-sdk` already supports deferring tool definitions behind a built-in `tool_search_tool` once the total tool count passes a threshold (`toolSearch.deferThreshold`, default 30). `GovernedSession` always registers a governance-aware override of that tool, so search results are filtered through the active profile before the model ever sees them.

## Goals

- Let applications register large tool catalogs without paying their full prompt cost on every turn.
- Filter tool-search results through the same tool allow/deny list used for execution (`executionEnvironments.*.tools`).
- Filter tool-search results through `toolClassifications`, so a tool whose classification the active profile can't reach is never surfaced as a candidate.
- Keep search dependency-free: ranking is a simple keyword-overlap scorer over each tool's name and description.
- Compose with the existing pre-execution gate (`onPreToolUse`): hiding a tool from search is a convenience and a token saving, not the only enforcement point.

## Non-goals

- Tool search does not replace the pre-execution classification gate described in [governed-sessions.md](./governed-sessions.md); a tool that somehow gets called despite not appearing in search is still evaluated there.
- The ranking function is not a semantic/embedding search. It is intentionally simple (keyword overlap) to avoid adding a model or vector-store dependency to the governance layer.
- This does not change which tools are *allowed*; it only changes which tools are *discoverable* in a given turn.

## Configuration

Set `toolSearch` once in `governance.config.json`; it applies to every profile's `SessionConfig`:

```json
"toolSearch": {
  "enabled": true,
  "deferThreshold": 30
}
```

- `enabled` — when `false`, every tool is pre-loaded and `tool_search_tool` is not engaged by the runtime.
- `deferThreshold` — the total tool count above which MCP/external tools are deferred behind search. Omit to use the runtime default (30).

## How results are filtered

`GovernedSession` registers `tool_search_tool` with `overridesBuiltInTool: true`. Its handler receives the runtime's live tool catalog (`invocation.availableTools`, including deferred MCP tools) and, for each candidate:

1. Normalizes the tool's name the same way the pre-execution gate does (`mcp:<server>-<tool>`, `builtin:<name>`, `custom:<name>`).
2. Drops it if it doesn't match the active profile's `tools` allow-list, or if it matches `deniedTools`.
3. Drops it if `toolClassifications` maps it to a classification the active profile's `upgradeTargets` can't reach.
4. Ranks what remains by keyword overlap between the query and each tool's name/description, and returns at most `limit` (default 10).

A tool search query therefore only ever returns tools the session could actually call right now — not a hint of what exists beyond the active profile's reach.

## Demo

[`nodejs/samples/mcps/catalog-demo-mcp-server.mjs`](../nodejs/samples/mcps/catalog-demo-mcp-server.mjs) is a synthetic MCP server with 35 unrelated, low-stakes tools (weather, currency conversion, calendar, translation, and so on) whose only purpose is to push the session's total tool count past the default defer threshold. It's wired into [`sample.governance.config.json`](../nodejs/samples/sample.governance.config.json) alongside `internal-data`, available from the `public` and `internal` profiles. The `confidential` profile's explicit tool allow-list excludes it, so it also demonstrates that tool search doesn't add a side channel around profile restrictions.

## Estimated token impact

[`nodejs/test/toolSearchTokenSavings.test.mjs`](../nodejs/test/toolSearchTokenSavings.test.mjs) is a heuristic (chars/4 ≈ tokens, not a real tokenizer) benchmark of the upfront tool-catalog payload with and without deferral:

| tools | baseline (no search) | with search | reduction |
| ---: | ---: | ---: | ---: |
| 10 | 1,455 | 1,521 | -5% (below the defer threshold) |
| 30 | 4,375 | 2,248 | 49% |
| 60 | 8,755 | 2,248 | 74% |
| 120 | 17,525 | 2,248 | 87% |
| 300 | 43,895 | 2,248 | 95% |

The "with search" cost stays roughly flat because it's dominated by the fixed cost of the inlined (non-deferred) tools plus one search call's results, not by the total catalog size. For an exact, non-heuristic figure, read the SDK's real context/usage RPC events from a live session instead of this estimate.

## Call data, not just token math

Token estimates alone don't prove the feature behaves correctly. [`test/governedSession.test.mjs`](../nodejs/test/governedSession.test.mjs)'s "tool search call report" test drives a representative catalog (an unclassified tool, a classification the active profile can't reach, one it can, and a built-in that carries MCP metadata too) through the full discover → gate → invoke path and prints the outcome of each:

```text
tool                                       | foundBySearch | gateDecision | invoked | profileBefore | profileAfter
internal-data-search_internal_docs         | true          | permit       | true    | public        | public
internal-data-get_confidential_demo_data   | false         | deny         | false   | public        | public
internal-data-get_internal_demo_data       | true          | permit       | true    | public        | internal
web_search                                 | true          | permit       | true    | internal      | internal
```

This confirms, with actual call outcomes rather than just counts: a tool hidden from search is also denied if called directly, a tool search surfaces is actually callable, and calling a classified tool upgrades the session exactly as it would for a directly-registered (non-deferred) tool.

