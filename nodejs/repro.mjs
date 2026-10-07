import { loadGovernanceConfig, GovernedSession } from "./dist/index.js";

const { policy, sessionConfigFor } = await loadGovernanceConfig("samples/sample.governance.config.json");

let capturedConfig;
const fakeSession = {
    sessionId: "repro",
    sendAndWait: async () => ({}),
    setModel: async () => {},
    on: () => () => {},
    disconnect: async () => {},
};
const client = { createSession: async (config) => { capturedConfig = config; return fakeSession; } };

await GovernedSession.create({
    client,
    policy,
    profile: "public",
    config: sessionConfigFor("public"),
});

console.log("public upgradeTargets:", policy.profiles.public.upgradeTargets);
console.log("classifications map:", policy.classifications);

const result = await capturedConfig.hooks.onPreToolUse(
    { sessionId: "repro", timestamp: new Date(), workingDirectory: ".", toolName: "mcp:internal-data-get_sales_data", toolArgs: { sensitivity: "confidential" } },
    { sessionId: "repro" }
);
console.log("onPreToolUse result:", result);
