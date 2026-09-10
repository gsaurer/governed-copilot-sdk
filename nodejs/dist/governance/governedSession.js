import { getProfile, isHigherSensitivity, matchesTool, applyProfile } from "./policy.js";
export class GovernedSession {
    session;
    ledger;
    policy;
    active;
    profiles;
    activeRef;
    constructor(session, options, active) {
        this.session = session;
        this.ledger = options.ledger;
        this.policy = options.policy;
        this.active = active;
        this.profiles = Object.values(options.policy.profiles);
        session.on((event) => {
            options.onEvent?.(event);
            void this.observe(event).catch((error) => {
                console.error(`[governance] failed to record ${event.type}: ${error instanceof Error ? error.message : String(error)}`);
            });
        });
    }
    static async create(options) {
        const active = getProfile(options.policy, options.profile);
        const baseConfig = options.config ?? {};
        const config = applyProfile({
            ...baseConfig,
            models: options.modelDefinitions ?? baseConfig.models,
        }, active);
        const activeRef = { current: active };
        const governedConfig = GovernedSession.withGovernanceHooks(config, activeRef, options.ledger);
        const session = await options.client.createSession(governedConfig);
        const governed = new GovernedSession(session, options, active);
        governed.activeRef = activeRef;
        await governed.record("session.created", { model: active.model ?? "runtime-default" });
        return governed;
    }
    get sessionId() {
        return this.session.sessionId;
    }
    get profile() {
        return this.active;
    }
    sendAndWait(...args) {
        return this.session.sendAndWait(...args);
    }
    async setSensitivity(sensitivity) {
        if (!isHigherSensitivity(sensitivity, this.active.sensitivity)) {
            throw new Error(`Sensitivity cannot move from '${this.active.sensitivity}' to '${sensitivity}'.`);
        }
        const target = this.profiles.find((profile) => profile.sensitivity === sensitivity);
        if (!target)
            throw new Error(`No profile exists for sensitivity '${sensitivity}'.`);
        await this.upgradeTo(target, "explicit-request");
    }
    async disconnect() {
        await this.session.disconnect();
        await this.record("session.closed");
    }
    static withGovernanceHooks(config, activeRef, ledger) {
        const existingHooks = config.hooks;
        const existingPermission = config.onPermissionRequest;
        const gate = (toolName) => {
            const profile = activeRef.current;
            const allowed = profile.tools;
            return !allowed || matchesTool(toolName, allowed) && !matchesTool(toolName, profile.deniedTools ?? []);
        };
        return {
            ...config,
            hooks: {
                ...existingHooks,
                onPreToolUse: async (input, invocation) => {
                    if (!gate(normalizeToolName(input.toolName))) {
                        await append(ledger, {
                            type: "tool.denied",
                            timestamp: new Date().toISOString(),
                            sessionId: invocation.sessionId,
                            profile: activeRef.current.name,
                            sensitivity: activeRef.current.sensitivity,
                            data: { toolName: input.toolName, reason: "profile-allow-list" },
                        });
                        return {
                            permissionDecision: "deny",
                            permissionDecisionReason: "Tool is not allowed by the active governance profile.",
                        };
                    }
                    return existingHooks?.onPreToolUse?.(input, invocation);
                },
            },
            onPermissionRequest: async (request, invocation) => {
                const toolName = permissionToolName(request);
                if (toolName && !gate(toolName)) {
                    return { kind: "reject", feedback: "Tool is not allowed by the active governance profile." };
                }
                if (existingPermission)
                    return existingPermission(request, invocation);
                return { kind: "approve-once" };
            },
        };
    }
    async observe(event) {
        if (event.type === "session.model_change") {
            await this.record("model.changed", { model: event.data.newModel });
        }
        if (event.type === "tool.execution_complete") {
            const data = event.data;
            const sensitivity = extractSensitivity(data);
            await this.record("tool.completed", {
                toolName: String(data.toolDescription?.name ?? "unknown"),
                resultSensitivity: sensitivity,
            });
            if (sensitivity && isHigherSensitivity(sensitivity, this.active.sensitivity)) {
                const target = this.profiles.find((profile) => profile.sensitivity === sensitivity);
                if (target)
                    await this.upgradeTo(target, "classified-tool-result");
            }
        }
    }
    async upgradeTo(target, reason) {
        const previous = this.active;
        this.active = target;
        if (this.activeRef)
            this.activeRef.current = target;
        if (target.model && target.model !== previous.model) {
            await this.session.setModel(target.model);
        }
        await this.record("sensitivity.upgraded", {
            previousProfile: previous.name,
            newProfile: target.name,
            previousSensitivity: previous.sensitivity,
            newSensitivity: target.sensitivity,
            reason,
        });
    }
    async record(type, data) {
        await this.ledger?.append({
            type,
            timestamp: new Date().toISOString(),
            sessionId: this.session.sessionId,
            profile: this.active.name,
            sensitivity: this.active.sensitivity,
            data,
        });
    }
}
function normalizeToolName(toolName) {
    if (toolName.startsWith("mcp:") || toolName.startsWith("custom:") || toolName.startsWith("builtin:")) {
        return toolName;
    }
    return toolName === "web_search" ? "builtin:web_search" : toolName;
}
function permissionToolName(request) {
    const value = request;
    if (request.kind === "custom-tool" && value.toolName)
        return `custom:${value.toolName}`;
    if (request.kind === "mcp" && value.toolName && value.serverName) {
        const name = value.toolName.startsWith(`${value.serverName}-`)
            ? value.toolName
            : `${value.serverName}-${value.toolName}`;
        return `mcp:${name}`;
    }
    return undefined;
}
function extractSensitivity(data) {
    const result = data.result;
    const meta = (result?.mcpMeta ?? data.mcpMeta ?? data.toolTelemetry);
    const governance = meta?.governance;
    const value = governance?.sensitivity;
    if (value === "public" || value === "internal" || value === "confidential" || value === "restricted") {
        return value;
    }
    const content = typeof result?.content === "string" ? result.content : "";
    return content.match(/Classification:\s*(public|internal|confidential|restricted)/i)?.[1]?.toLowerCase();
}
function append(ledger, record) {
    return ledger?.append(record) ?? Promise.resolve();
}
