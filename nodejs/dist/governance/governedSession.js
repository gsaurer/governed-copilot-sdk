import { assertModelAllowed, getProfile, isHigherSensitivity, matchesTool, applyProfile } from "./policy.js";
export class GovernedSession {
    session;
    ledger;
    policy;
    onSensitivityChanged;
    active;
    profiles;
    activeRef;
    toolNamesByCallId = new Map();
    constructor(session, options, active) {
        this.session = session;
        this.ledger = options.ledger;
        this.policy = options.policy;
        this.onSensitivityChanged = options.onSensitivityChanged;
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
                    const toolName = normalizeToolName(input.toolName, activeRef.current);
                    if (!gate(toolName)) {
                        await append(ledger, {
                            type: "tool.denied",
                            timestamp: new Date().toISOString(),
                            sessionId: invocation.sessionId,
                            profile: activeRef.current.name,
                            sensitivity: activeRef.current.sensitivity,
                            environment: activeRef.current.environment,
                            data: { toolName, reason: "profile-allow-list" },
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
        if (event.type === "tool.execution_start") {
            this.toolNamesByCallId.set(event.data.toolCallId, event.data.toolName);
            return;
        }
        if (event.type === "session.model_change") {
            try {
                assertModelAllowed(this.active, event.data.newModel);
            }
            catch (error) {
                await this.record("model.denied", {
                    model: event.data.newModel,
                    reason: error instanceof Error ? error.message : String(error),
                });
                await this.session.disconnect();
                throw error;
            }
            await this.record("model.changed", { model: event.data.newModel });
        }
        if (event.type === "tool.execution_complete") {
            const data = event.data;
            const toolCallId = String(data.toolCallId ?? "");
            const toolName = this.toolNamesByCallId.get(toolCallId)
                ?? data.toolDescription?.name
                ?? "unknown";
            const sensitivity = extractSensitivity(data)
                ?? configuredToolSensitivity(this.policy.toolSensitivity, toolName, this.active);
            this.toolNamesByCallId.delete(toolCallId);
            await this.record("tool.completed", {
                toolName,
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
        this.onSensitivityChanged?.({ previous, current: target, reason });
    }
    async record(type, data) {
        await this.ledger?.append({
            type,
            timestamp: new Date().toISOString(),
            sessionId: this.session.sessionId,
            profile: this.active.name,
            sensitivity: this.active.sensitivity,
            environment: this.active.environment,
            data,
        });
    }
}
function normalizeToolName(toolName, profile) {
    if (toolName.startsWith("mcp:") || toolName.startsWith("custom:") || toolName.startsWith("builtin:")) {
        return toolName;
    }
    if (toolName === "governance_policy" || toolName === "governance_set_sensitivity") {
        return `builtin:${toolName}`;
    }
    for (const serverName of Object.keys(profile?.mcpServers ?? {})) {
        if (toolName.startsWith(`${serverName}-`))
            return `mcp:${toolName}`;
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
    const metadata = [result?._meta, result?.mcpMeta, data._meta, data.mcpMeta, data.toolTelemetry];
    for (const candidate of metadata) {
        const meta = candidate;
        const governance = meta?.governance;
        const value = governance?.sensitivity ?? meta?.sensitivity ?? meta?.classification ?? meta?.ifc;
        if (isSensitivity(value))
            return value;
    }
    const content = [
        result?.content,
        result?.detailedContent,
        result?.structuredContent,
        result?.contents,
    ].map(stringifyResultContent).filter(Boolean).join("\n");
    const match = content.match(/(?:classification|sensitivity|sensitivity label|information protection|confidentiality)\s*[:=-]\s*(public|internal|confidential|restricted)/i)
        ?? content.match(/\b(public|internal|confidential|restricted)\s*:/i);
    if (match)
        return match[1].toLowerCase();
}
function configuredToolSensitivity(toolSensitivity, toolName, profile) {
    if (!toolSensitivity)
        return undefined;
    return toolSensitivity[toolName] ?? toolSensitivity[normalizeToolName(toolName, profile)];
}
function isSensitivity(value) {
    return value === "public" || value === "internal" || value === "confidential" || value === "restricted";
}
function stringifyResultContent(value) {
    if (typeof value === "string")
        return value;
    if (Array.isArray(value)) {
        return value.map((item) => {
            if (typeof item === "string")
                return item;
            if (item && typeof item === "object" && "text" in item && typeof item.text === "string")
                return item.text;
            return "";
        }).filter(Boolean).join("\n");
    }
    if (value && typeof value === "object")
        return JSON.stringify(value);
    return "";
}
function append(ledger, record) {
    return ledger?.append(record) ?? Promise.resolve();
}
