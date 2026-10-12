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

test("create() auto-injects a governance-aware tool_search_tool override", async () => {
  let capturedConfig;
  const fakeSession = makeFakeSdkSession();
  const client = { createSession: async (config) => { capturedConfig = config; return fakeSession; } };
  await GovernedSession.create({
    client,
    policy: makeThreeLevelPolicy(undefined),
    profile: "public",
  });

  const toolSearchTool = capturedConfig.tools.find((tool) => tool.name === "tool_search_tool");
  assert.ok(toolSearchTool);
  assert.equal(toolSearchTool.overridesBuiltInTool, true);
});

test("tool_search_tool excludes tools outside the active profile's allow-list", async () => {
  let capturedConfig;
  const fakeSession = makeFakeSdkSession();
  const client = { createSession: async (config) => { capturedConfig = config; return fakeSession; } };
  const policy = makeThreeLevelPolicy(undefined);
  policy.profiles.public.tools = ["mcp:internal-data-get_sales_data"];
  await GovernedSession.create({ client, policy, profile: "public" });

  const toolSearchTool = capturedConfig.tools.find((tool) => tool.name === "tool_search_tool");
  const availableTools = [
    { name: "internal-data-get_sales_data", mcpServerName: "internal-data", mcpToolName: "get_sales_data", description: "Fetch sales data." },
    { name: "internal-data-get_renewal_data", mcpServerName: "internal-data", mcpToolName: "get_renewal_data", description: "Fetch renewal sales data." },
  ];

  const result = await toolSearchTool.handler({ query: "sales" }, { availableTools });

  assert.deepEqual(result.tools.map((tool) => tool.name), ["internal-data-get_sales_data"]);
});

test("tool_search_tool excludes tools whose configured classification is unreachable", async () => {
  let capturedConfig;
  const fakeSession = makeFakeSdkSession();
  const client = { createSession: async (config) => { capturedConfig = config; return fakeSession; } };
  const policy = makeThreeLevelPolicy({ "mcp:internal-data-get_confidential_demo_data": "confidential" });
  await GovernedSession.create({ client, policy, profile: "public" });

  const toolSearchTool = capturedConfig.tools.find((tool) => tool.name === "tool_search_tool");
  const availableTools = [
    { name: "internal-data-get_internal_demo_data", mcpServerName: "internal-data", mcpToolName: "get_internal_demo_data", description: "Internal demo data." },
    { name: "internal-data-get_confidential_demo_data", mcpServerName: "internal-data", mcpToolName: "get_confidential_demo_data", description: "Confidential demo data." },
  ];

  const result = await toolSearchTool.handler({ query: "demo data" }, { availableTools });

  assert.deepEqual(result.tools.map((tool) => tool.name), ["internal-data-get_internal_demo_data"]);
});

test("tool_search_tool ranks by keyword overlap and respects limit", async () => {
  let capturedConfig;
  const fakeSession = makeFakeSdkSession();
  const client = { createSession: async (config) => { capturedConfig = config; return fakeSession; } };
  await GovernedSession.create({ client, policy: makeThreeLevelPolicy(undefined), profile: "public" });

  const toolSearchTool = capturedConfig.tools.find((tool) => tool.name === "tool_search_tool");
  const availableTools = [
    { name: "get_weather", description: "Look up current weather for a city." },
    { name: "get_sales_data", description: "Fetch internal and confidential sales figures." },
    { name: "get_sales_forecast", description: "Project future sales figures." },
  ];

  const result = await toolSearchTool.handler({ query: "sales figures", limit: 1 }, { availableTools });

  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0].name, "get_sales_data");
});

// Confirmed against a real session: CurrentToolMetadata for web_search carries mcpServerName
// "github-mcp-server" even though onPreToolUse normalizes a live web_search call to
// "builtin:web_search" (bare toolName, no server info). Search filtering must agree.
test("tool_search_tool normalizes web_search as builtin:web_search despite its mcpServerName metadata", async () => {
  let capturedConfig;
  const fakeSession = makeFakeSdkSession();
  const client = { createSession: async (config) => { capturedConfig = config; return fakeSession; } };
  const policy = makeThreeLevelPolicy(undefined);
  policy.profiles.public.tools = ["builtin:web_search"];
  await GovernedSession.create({ client, policy, profile: "public" });

  const toolSearchTool = capturedConfig.tools.find((tool) => tool.name === "tool_search_tool");
  const availableTools = [
    { name: "web_search", namespacedName: "github-mcp-server/web_search", mcpServerName: "github-mcp-server", mcpToolName: "web_search", description: "Search the web for current information." },
    { name: "internal-data-get_sales_data", mcpServerName: "internal-data", mcpToolName: "get_sales_data", description: "Fetch sales data." },
  ];

  const found = await toolSearchTool.handler({ query: "search" }, { availableTools });
  assert.deepEqual(found.tools.map((tool) => tool.name), ["web_search"]);

  const webSearchDecision = await capturedConfig.hooks.onPreToolUse(
    { sessionId: "test-session", timestamp: new Date(), workingDirectory: ".", toolName: "web_search", toolArgs: {} },
    { sessionId: "test-session" }
  );
  assert.equal(webSearchDecision, undefined);

  const salesDataDecision = await capturedConfig.hooks.onPreToolUse(
    { sessionId: "test-session", timestamp: new Date(), workingDirectory: ".", toolName: "mcp:internal-data-get_sales_data", toolArgs: {} },
    { sessionId: "test-session" }
  );
  assert.equal(salesDataDecision.permissionDecision, "deny");
});

test("tools surfaced by tool_search_tool are also permitted by the pre-execution gate (search and calling agree)", async () => {
  let capturedConfig;
  const fakeSession = makeFakeSdkSession();
  const client = { createSession: async (config) => { capturedConfig = config; return fakeSession; } };
  const policy = makeThreeLevelPolicy({ "mcp:internal-data-get_confidential_demo_data": "confidential" });
  policy.profiles.public.tools = ["mcp:internal-data-*"];
  await GovernedSession.create({ client, policy, profile: "public" });

  const toolSearchTool = capturedConfig.tools.find((tool) => tool.name === "tool_search_tool");
  const availableTools = [
    { name: "internal-data-get_internal_demo_data", mcpServerName: "internal-data", mcpToolName: "get_internal_demo_data", description: "Internal demo data." },
    { name: "internal-data-get_confidential_demo_data", mcpServerName: "internal-data", mcpToolName: "get_confidential_demo_data", description: "Confidential demo data." },
    { name: "unrelated-server-tool", mcpServerName: "unrelated-server", mcpToolName: "tool", description: "Not part of this profile." },
  ];

  const found = await toolSearchTool.handler({ query: "demo data" }, { availableTools });
  assert.deepEqual(found.tools.map((tool) => tool.name), ["internal-data-get_internal_demo_data"]);

  // Every tool search said yes to must also be callable: onPreToolUse should not deny it.
  for (const tool of found.tools) {
    const decision = await capturedConfig.hooks.onPreToolUse(
      { sessionId: "test-session", timestamp: new Date(), workingDirectory: ".", toolName: `mcp:internal-data-${tool.name.replace("internal-data-", "")}`, toolArgs: {} },
      { sessionId: "test-session" }
    );
    assert.equal(decision, undefined, `expected '${tool.name}' to be callable since tool search surfaced it`);
  }
});

test("tools excluded by tool_search_tool are also denied if called directly (no end-run around search filtering)", async () => {
  let capturedConfig;
  const fakeSession = makeFakeSdkSession();
  const client = { createSession: async (config) => { capturedConfig = config; return fakeSession; } };
  const policy = makeThreeLevelPolicy({ "mcp:internal-data-get_confidential_demo_data": "confidential" });
  policy.profiles.public.tools = ["mcp:internal-data-*"];
  await GovernedSession.create({ client, policy, profile: "public" });

  const toolSearchTool = capturedConfig.tools.find((tool) => tool.name === "tool_search_tool");
  const availableTools = [
    { name: "internal-data-get_confidential_demo_data", mcpServerName: "internal-data", mcpToolName: "get_confidential_demo_data", description: "Confidential demo data." },
    { name: "unrelated-server-tool", mcpServerName: "unrelated-server", mcpToolName: "tool", description: "Not part of this profile." },
  ];

  const found = await toolSearchTool.handler({ query: "demo data unrelated" }, { availableTools });
  assert.deepEqual(found.tools, [], "both tools should be hidden from search (classification-unreachable and not in the allow-list)");

  const deniedByClassification = await capturedConfig.hooks.onPreToolUse(
    { sessionId: "test-session", timestamp: new Date(), workingDirectory: ".", toolName: "mcp:internal-data-get_confidential_demo_data", toolArgs: {} },
    { sessionId: "test-session" }
  );
  assert.equal(deniedByClassification.permissionDecision, "deny");

  const deniedByAllowList = await capturedConfig.hooks.onPreToolUse(
    { sessionId: "test-session", timestamp: new Date(), workingDirectory: ".", toolName: "mcp:unrelated-server-tool", toolArgs: {} },
    { sessionId: "test-session" }
  );
  assert.equal(deniedByAllowList.permissionDecision, "deny");
});

test("a tool discovered via tool_search_tool can be called end-to-end and still upgrades classification", async () => {
  let capturedConfig;
  const fakeSession = makeFakeSdkSession();
  const client = { createSession: async (config) => { capturedConfig = config; return fakeSession; } };
  const policy = makeThreeLevelPolicy({ "mcp:internal-data-get_sales_data": "internal" });
  const governed = await GovernedSession.create({ client, policy, profile: "public" });

  const toolSearchTool = capturedConfig.tools.find((tool) => tool.name === "tool_search_tool");
  const found = await toolSearchTool.handler(
    { query: "sales" },
    { availableTools: [{ name: "internal-data-get_sales_data", mcpServerName: "internal-data", mcpToolName: "get_sales_data", description: "Fetch sales data." }] }
  );
  assert.deepEqual(found.tools.map((tool) => tool.name), ["internal-data-get_sales_data"]);

  const decision = await capturedConfig.hooks.onPreToolUse(
    { sessionId: "test-session", timestamp: new Date(), workingDirectory: ".", toolName: "mcp:internal-data-get_sales_data", toolArgs: {} },
    { sessionId: "test-session" }
  );
  assert.equal(decision, undefined);

  await completeTool(fakeSession, "mcp:internal-data-get_sales_data", { content: [{ type: "text", text: "ok" }] });

  assert.equal(governed.profile.name, "internal");
});

test("tool search call report: discovery, gate decision, and invocation outcome per tool", async () => {
  let capturedConfig;
  const fakeSession = makeFakeSdkSession();
  const client = { createSession: async (config) => { capturedConfig = config; return fakeSession; } };
  const policy = makeThreeLevelPolicy({
    "mcp:internal-data-get_internal_demo_data": "internal",
    "mcp:internal-data-get_confidential_demo_data": "confidential",
  });
  const governed = await GovernedSession.create({ client, policy, profile: "public" });
  const toolSearchTool = capturedConfig.tools.find((tool) => tool.name === "tool_search_tool");

  // A representative deferred catalog: one unclassified tool, one unreachable classification
  // (checked while the profile is still public), one reachable classification, and a built-in
  // that carries mcpServerName metadata too. Order matters: the unreachable one must be checked
  // before any upgrade happens, since reachability depends on the *active* profile at call time.
  const catalog = [
    { name: "internal-data-search_internal_docs", mcpServerName: "internal-data", mcpToolName: "search_internal_docs", description: "Search synthetic internal documentation.", query: "internal documents" },
    { name: "internal-data-get_confidential_demo_data", mcpServerName: "internal-data", mcpToolName: "get_confidential_demo_data", description: "Confidential demo data.", query: "confidential demo data" },
    { name: "internal-data-get_internal_demo_data", mcpServerName: "internal-data", mcpToolName: "get_internal_demo_data", description: "Internal demo data.", query: "internal demo data" },
    { name: "web_search", mcpServerName: "github-mcp-server", mcpToolName: "web_search", description: "Search the web for current information.", query: "web search" },
  ];

  const callData = [];
  for (const entry of catalog) {
    const profileBeforeCall = governed.profile.name;

    const searchResult = await toolSearchTool.handler({ query: entry.query }, { availableTools: catalog });
    const foundBySearch = searchResult.tools.some((tool) => tool.name === entry.name);

    const normalizedToolName = entry.mcpServerName === "github-mcp-server" ? entry.name : `mcp:${entry.mcpServerName}-${entry.mcpToolName}`;
    const decision = await capturedConfig.hooks.onPreToolUse(
      { sessionId: "test-session", timestamp: new Date(), workingDirectory: ".", toolName: normalizedToolName, toolArgs: {} },
      { sessionId: "test-session" }
    );
    const permitted = decision === undefined;

    let invoked = false;
    if (permitted) {
      await completeTool(fakeSession, normalizedToolName, { content: [{ type: "text", text: "ok" }] });
      invoked = true;
    }

    callData.push({
      tool: entry.name,
      foundBySearch,
      gateDecision: permitted ? "permit" : "deny",
      denyReason: permitted ? "" : decision.permissionDecisionReason,
      invoked,
      profileBefore: profileBeforeCall,
      profileAfter: governed.profile.name,
    });
  }

  console.log("\nTool search call report:");
  console.table(callData);

  assert.deepEqual(
    callData.map((row) => [row.tool, row.foundBySearch, row.gateDecision, row.invoked]),
    [
      ["internal-data-search_internal_docs", true, "permit", true],
      ["internal-data-get_confidential_demo_data", false, "deny", false],
      ["internal-data-get_internal_demo_data", true, "permit", true],
      ["web_search", true, "permit", true],
    ]
  );
  assert.equal(callData[1].profileBefore, "public", "the unreachable classification must be checked before any upgrade happens");
  assert.equal(callData[2].profileAfter, "internal", "calling the internal-classified tool should upgrade the session");
  assert.equal(governed.profile.name, "internal", "the confidential-classified tool was never callable, so the session never reached confidential");
});


