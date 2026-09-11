import test from "node:test";
import assert from "node:assert/strict";
import { GovernedSession, matchesTool } from "../dist/index.js";

function makePolicy(toolSensitivity) {
  return {
    profiles: {
      public: { name: "public", sensitivity: "public" },
      internal: { name: "internal", sensitivity: "internal" },
    },
    toolSensitivity,
  };
}

// A minimal in-memory stand-in for the real Copilot SDK session, exposing just
// enough of GovernedSdkSession to drive GovernedSession's event handling.
function makeFakeSdkSession() {
  let handler;
  return {
    sessionId: "test-session",
    sendAndWait: async () => ({}),
    setModel: async () => {},
    on: (fn) => { handler = fn; return () => {}; },
    disconnect: async () => {},
    emit: (event) => handler(event),
  };
}

async function completeTool(session, toolName, result = {}) {
  session.emit({ type: "tool.execution_start", data: { toolCallId: "1", toolName } });
  session.emit({ type: "tool.execution_complete", data: { toolCallId: "1", result } });
  // observe() runs fire-and-forget off the event; let its chained awaits settle.
  await new Promise((resolve) => setImmediate(resolve));
}

test("wildcard toolSensitivity pattern upgrades sensitivity", async () => {
  const fakeSession = makeFakeSdkSession();
  const client = { createSession: async () => fakeSession };
  let changed;
  const governed = await GovernedSession.create({
    client,
    policy: makePolicy({ "mcp:fabric-local-*": "internal" }),
    profile: "public",
    onSensitivityChanged: (change) => { changed = change; },
  });

  await completeTool(fakeSession, "mcp:fabric-local-list_items");

  assert.equal(governed.profile.name, "internal");
  assert.equal(changed?.current.name, "internal");
});

test("non-matching tool name does not upgrade sensitivity", async () => {
  const fakeSession = makeFakeSdkSession();
  const client = { createSession: async () => fakeSession };
  const governed = await GovernedSession.create({
    client,
    policy: makePolicy({ "mcp:fabric-local-*": "internal" }),
    profile: "public",
  });

  await completeTool(fakeSession, "mcp:other-server-list_items");

  assert.equal(governed.profile.name, "public");
});

test("exact toolSensitivity match still upgrades sensitivity", async () => {
  const fakeSession = makeFakeSdkSession();
  const client = { createSession: async () => fakeSession };
  const governed = await GovernedSession.create({
    client,
    policy: makePolicy({ "mcp:internal-docs-get_sales_data": "internal" }),
    profile: "public",
  });

  await completeTool(fakeSession, "mcp:internal-docs-get_sales_data");

  assert.equal(governed.profile.name, "internal");
});

test("tool policy supports trailing wildcards", () => {
  assert.equal(matchesTool("mcp:internal-data-get_sales_data", ["mcp:internal-data-* ".trim()]), true);
  assert.equal(matchesTool("mcp:workiq-search_context", ["mcp:internal-data-* ".trim()]), false);
});

test("create() auto-injects read_governance_policy and set_sensitivity builtin tools", async () => {
  let capturedConfig;
  const fakeSession = makeFakeSdkSession();
  const client = { createSession: async (config) => { capturedConfig = config; return fakeSession; } };
  await GovernedSession.create({
    client,
    policy: makePolicy(undefined),
    profile: "public",
  });

  const toolNames = capturedConfig.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes("read_governance_policy"));
  assert.ok(toolNames.includes("set_sensitivity"));
});
