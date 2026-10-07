import test from "node:test";
import assert from "node:assert/strict";
import { GovernedSession, matchesTool } from "../dist/index.js";

function makePolicy(toolClassifications) {
  return {
    profiles: {
      public: { name: "public", classifications: ["public"], upgradeTargets: ["internal"] },
      internal: { name: "internal", classifications: ["internal"], upgradeTargets: [] },
    },
    classifications: { public: "public", internal: "internal" },
    toolClassifications,
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

test("wildcard toolClassifications pattern upgrades classification", async () => {
  const fakeSession = makeFakeSdkSession();
  const client = { createSession: async () => fakeSession };
  let changed;
  const governed = await GovernedSession.create({
    client,
    policy: makePolicy({ "mcp:fabric-local-*": "internal" }),
    profile: "public",
    onClassificationChanged: (change) => { changed = change; },
  });

  await completeTool(fakeSession, "mcp:fabric-local-list_items");

  assert.equal(governed.profile.name, "internal");
  assert.equal(changed?.current.name, "internal");
});

test("non-matching tool name does not upgrade classification", async () => {
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

test("exact toolClassifications match still upgrades classification", async () => {
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

test("create() auto-injects read_governance_policy and set_classification builtin tools", async () => {
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
  assert.ok(toolNames.includes("set_classification"));
});

test("set_classification rejects model-inference source when modelClassification is disabled", async () => {
  let capturedConfig;
  const fakeSession = makeFakeSdkSession();
  const client = { createSession: async (config) => { capturedConfig = config; return fakeSession; } };
  const governed = await GovernedSession.create({
    client,
    policy: makePolicy(undefined),
    profile: "public",
  });

  const classificationTool = capturedConfig.tools.find((tool) => tool.name === "set_classification");
  const result = await classificationTool.handler({ classification: "internal", source: "model-inference", evidence: "test" });

  assert.equal(result.success, false);
  assert.equal(result.error, "model_inferred_classification_is_disabled_by_policy");
  assert.equal(governed.profile.name, "public");
});

test("set_classification accepts model-inference source when modelClassification is enabled", async () => {
  let capturedConfig;
  const fakeSession = makeFakeSdkSession();
  const client = { createSession: async (config) => { capturedConfig = config; return fakeSession; } };
  const policy = { ...makePolicy(undefined), modelClassification: { enabled: true } };
  const governed = await GovernedSession.create({
    client,
    policy,
    profile: "public",
  });

  const classificationTool = capturedConfig.tools.find((tool) => tool.name === "set_classification");
  const result = await classificationTool.handler({ classification: "internal", source: "model-inference", evidence: "test" });

  assert.equal(result.success, true);
  assert.equal(governed.profile.name, "internal");
});

// Public can reach internal but not confidential, matching the sample demo config.
function makeThreeLevelPolicy(toolClassifications) {
  return {
    profiles: {
      public: { name: "public", classifications: ["public"], upgradeTargets: ["internal"] },
      internal: { name: "internal", classifications: ["internal"], upgradeTargets: ["confidential"] },
      confidential: { name: "confidential", classifications: ["confidential"], upgradeTargets: [] },
    },
    classifications: { public: "public", internal: "internal", confidential: "confidential" },
    toolClassifications,
  };
}

test("pre-flight: tool with a configured classification unreachable from the active profile is denied", async () => {
  let capturedConfig;
  const fakeSession = makeFakeSdkSession();
  const client = { createSession: async (config) => { capturedConfig = config; return fakeSession; } };
  await GovernedSession.create({
    client,
    policy: makeThreeLevelPolicy({ "mcp:internal-data-get_confidential_demo_data": "confidential" }),
    profile: "public",
  });

  const result = await capturedConfig.hooks.onPreToolUse(
    { sessionId: "test-session", timestamp: new Date(), workingDirectory: ".", toolName: "mcp:internal-data-get_confidential_demo_data", toolArgs: {} },
    { sessionId: "test-session" }
  );

  assert.equal(result.permissionDecision, "deny");
  assert.match(result.permissionDecisionReason, /not reachable/);
});

test("pre-flight: an explicit classification argument unreachable from the active profile is denied before execution", async () => {
  let capturedConfig;
  const fakeSession = makeFakeSdkSession();
  const client = { createSession: async (config) => { capturedConfig = config; return fakeSession; } };
  await GovernedSession.create({
    client,
    policy: makeThreeLevelPolicy(undefined),
    profile: "public",
  });

  const result = await capturedConfig.hooks.onPreToolUse(
    { sessionId: "test-session", timestamp: new Date(), workingDirectory: ".", toolName: "mcp:internal-data-get_sales_data", toolArgs: { classification: "confidential" } },
    { sessionId: "test-session" }
  );

  assert.equal(result.permissionDecision, "deny");
  assert.match(result.permissionDecisionReason, /not reachable/);
});

test("pre-flight: a classification reachable via upgradeTargets is not denied", async () => {
  let capturedConfig;
  const fakeSession = makeFakeSdkSession();
  const client = { createSession: async (config) => { capturedConfig = config; return fakeSession; } };
  await GovernedSession.create({
    client,
    policy: makeThreeLevelPolicy(undefined),
    profile: "public",
  });

  const result = await capturedConfig.hooks.onPreToolUse(
    { sessionId: "test-session", timestamp: new Date(), workingDirectory: ".", toolName: "mcp:internal-data-get_sales_data", toolArgs: { classification: "internal" } },
    { sessionId: "test-session" }
  );

  assert.equal(result, undefined);
});

test("content-derived classification with trailing prose still upgrades (regression)", async () => {
  const fakeSession = makeFakeSdkSession();
  const client = { createSession: async () => fakeSession };
  const governed = await GovernedSession.create({
    client,
    policy: makeThreeLevelPolicy(undefined),
    profile: "public",
  });

  await completeTool(fakeSession, "mcp:internal-data-get_sales_data", {
    content: [{
      type: "text",
      text: "Classification: internal. Internal sales information is non-public operational data for workforce and approved partners; do not publish it externally.",
    }],
  });

  assert.equal(governed.profile.name, "internal");
});
