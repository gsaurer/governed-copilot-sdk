import {
    defineTool,
    type CopilotSession,
    type PermissionRequest,
    type SessionConfig,
    type SessionEvent,
} from "@github/copilot-sdk";
import { assertModelAllowed, getProfile, isClassificationSatisfied, isHigherClassification, matchesTool, applyProfile, profileForClassification } from "./policy.js";
import type {
    EvidenceLedger,
    EvidenceRecord,
    GovernancePolicy,
    GovernedSessionOptions,
    GovernanceProfile,
    GovernedSdkSession,
    DataClassification,
} from "./types.js";

type PreToolInput = {
    sessionId: string;
    timestamp: Date;
    workingDirectory: string;
    toolName: string;
    toolArgs: unknown;
};

export class GovernedSession {
    private readonly session: GovernedSdkSession;
    private readonly ledger?: EvidenceLedger;
    private readonly policy: GovernedSessionOptions["policy"];
    private readonly onClassificationChanged?: GovernedSessionOptions["onClassificationChanged"];
    private active: GovernanceProfile;
    private readonly profiles: GovernanceProfile[];
    private activeRef?: { current: GovernanceProfile };
    private readonly toolNamesByCallId = new Map<string, string>();

    private constructor(
        session: GovernedSdkSession,
        options: GovernedSessionOptions,
        active: GovernanceProfile
    ) {
        this.session = session;
        this.ledger = options.ledger;
        this.policy = options.policy;
        this.onClassificationChanged = options.onClassificationChanged;
        this.active = active;
        this.profiles = Object.values(options.policy.profiles);
        session.on((event) => {
            options.onEvent?.(event);
            void this.observe(event).catch((error) => {
                console.error(`[governance] failed to record ${event.type}: ${error instanceof Error ? error.message : String(error)}`);
            });
        });
    }

    public static async create(options: GovernedSessionOptions): Promise<GovernedSession> {
        const active = getProfile(options.policy, options.profile);
        const baseConfig = options.config ?? {};
        const config = applyProfile(
            {
                ...baseConfig,
                models: options.modelDefinitions ?? baseConfig.models,
            } as SessionConfig,
            active
        );
        const activeRef = { current: active };
        const governedRef: { current?: GovernedSession } = {};
        const configWithBuiltInTools = GovernedSession.withBuiltInGovernanceTools(config, options.policy, governedRef);
        const governedConfig = GovernedSession.withGovernanceHooks(configWithBuiltInTools, options.policy, activeRef, options.ledger);
        const session = await options.client.createSession(governedConfig);
        const governed = new GovernedSession(session, options, active);
        governed.activeRef = activeRef;
        governedRef.current = governed;
        await governed.record("session.created", { model: active.model ?? "runtime-default" });
        return governed;
    }

    public get sessionId(): string {
        return this.session.sessionId;
    }

    public get profile(): GovernanceProfile {
        return this.active;
    }

    public sendAndWait<T = unknown>(...args: unknown[]): Promise<T> {
        return this.session.sendAndWait(...args) as Promise<T>;
    }

    public async abort(): Promise<void> {
        await this.session.abort();
    }

    public async setClassification(classification: DataClassification, reason = "explicit-request", details?: Record<string, unknown>): Promise<void> {
        const target = profileForClassification(this.policy, classification);
        if (!target) throw new Error(`Unknown data classification '${classification}'.`);
        if (!isHigherClassification(this.policy, classification, this.active)) {
            throw new Error(`Classification cannot move from '${this.currentClassification()}' to '${classification}'.`);
        }
        await this.upgradeTo(target, reason, details);
    }

    private currentClassification(): DataClassification | undefined {
        return this.active.classifications[0];
    }

    public async disconnect(reason = "client-disconnect"): Promise<void> {
        await this.session.disconnect();
        await this.record("session.closed", { reason });
    }

    private static withBuiltInGovernanceTools(
        config: SessionConfig,
        policy: GovernancePolicy,
        governedRef: { current?: GovernedSession }
    ): SessionConfig {
        const policyTool = defineTool("read_governance_policy", {
            description: "Read-only view of the current session state and loaded governance configuration. Use for questions about data classifications, profiles, allowed models, tools, or MCP servers, including requests to lower classification. Configuration changes and classification downgrades are forbidden.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Optional question or scope, such as a classification, profile name, or 'all'." },
                },
            },
            skipPermission: true,
            handler: ({ query }: { query?: string }) => {
                const current = governedRef.current?.profile;
                return {
                    currentSession: current ? {
                        profile: current.name,
                        classifications: current.classifications,
                        environment: current.environment,
                    } : undefined,
                    classifications: policy.classifications,
                    profiles: Object.fromEntries(Object.entries(policy.profiles)
                        .filter(([name, profile]) => matchesPolicyQuery(query, name, profile.classifications))
                        .map(([name, profile]) => [name, {
                            classifications: profile.classifications,
                            upgradeTargets: profile.upgradeTargets,
                            environment: profile.environment,
                            model: profile.model,
                            allowedModels: profile.allowedModels ?? [],
                            deniedModels: profile.deniedModels ?? [],
                            tools: profile.tools ?? [],
                            deniedTools: profile.deniedTools ?? [],
                            mcpServers: Object.keys(profile.mcpServers ?? {}),
                        }])),
                    toolClassifications: policy.toolClassifications ?? {},
                    readOnly: true,
                    query: query ?? "all",
                };
            },
        });
        const modelClassificationEnabled = policy.modelClassification?.enabled === true;
        const classificationTool = defineTool("set_classification", {
            description: modelClassificationEnabled
                ? "Governed control for a requested data classification. Use for explicit user requests and when analyzed content or tool results indicate a higher classification. Downgrades are rejected."
                : "Governed control for a requested data classification. Use only for explicit user requests to change classification. Downgrades are rejected.",
            parameters: {
                type: "object",
                properties: {
                    classification: { type: "string", enum: Object.keys(policy.classifications) },
                    source: {
                        type: "string",
                        enum: ["user-request", "model-inference"],
                        description: "Use 'user-request' when the user explicitly asked. Use 'model-inference' when you determined the classification by analyzing content or tool results.",
                    },
                    evidence: { type: "string", description: "For model-inference, the observed content or tool result that indicates this classification." },
                },
                required: ["classification", "source"],
            },
            skipPermission: true,
            handler: async ({ classification, source, evidence }: { classification: DataClassification; source?: string; evidence?: string }) => {
                const governed = governedRef.current!;
                const inferred = source === "model-inference";
                if (inferred && !modelClassificationEnabled) {
                    await governed.record("classification.inference_rejected", { requested: classification, evidence });
                    return {
                        success: false,
                        profile: governed.profile.name,
                        classifications: governed.profile.classifications,
                        error: "model_inferred_classification_is_disabled_by_policy",
                    };
                }
                try {
                    await governed.setClassification(classification, inferred ? "model-inferred-classification" : "user-requested-classification", {
                        classificationSource: inferred ? "model-inference" : "user-request",
                        evidence,
                    });
                    return { success: true, profile: governed.profile.name, classifications: governed.profile.classifications };
                } catch (error) {
                    return {
                        success: false,
                        profile: governed.profile.name,
                        classifications: governed.profile.classifications,
                        error: error instanceof Error ? error.message : String(error),
                    };
                }
            },
        });
        const baseGuidance = "Use read_governance_policy to answer questions about the current session and configured profiles, data classifications, allowed models, tools, and MCP servers. Use set_classification for every user request to upgrade or downgrade classification with source 'user-request', and do not claim success until that tool returns success. The tool enforces monotonic profile transitions: upgrade requests can succeed when policy allows them, while downgrade requests are rejected and the session remains at its current profile. Never change governance configuration from chat.";
        const inferenceGuidance = "Data classification analysis is enabled. After each tool result or retrieved content, assess whether it indicates a higher data classification than the current session profile. If it does, call set_classification with the indicated classification, source 'model-inference', and the observed evidence, before continuing your answer. Only raise classification; never request a lower one. An explicit label supplied by a tool or source system is authoritative over your own judgement.";
        const guidance = modelClassificationEnabled ? `${baseGuidance}\n\n${inferenceGuidance}` : baseGuidance;
        const existingContent = config.systemMessage?.content;
        return {
            ...config,
            tools: [...(config.tools ?? []), policyTool, classificationTool],
            systemMessage: {
                ...config.systemMessage,
                content: existingContent ? `${existingContent}\n\n${guidance}` : guidance,
            },
        } as SessionConfig;
    }

    private static withGovernanceHooks(
        config: SessionConfig,
        policy: GovernancePolicy,
        activeRef: { current: GovernanceProfile },
        ledger: EvidenceLedger | undefined
    ): SessionConfig {
        const existingHooks = config.hooks;
        const existingPermission = config.onPermissionRequest;
        const gate = (toolName: string): boolean => {
            const profile = activeRef.current;
            const allowed = profile.tools;
            return !allowed || matchesTool(toolName, allowed) && !matchesTool(toolName, profile.deniedTools ?? []);
        };
        return {
            ...config,
            hooks: {
                ...existingHooks,
                onPreToolUse: async (input: PreToolInput, invocation: { sessionId: string }) => {
                    const toolName = normalizeToolName(input.toolName, activeRef.current);
                    if (!gate(toolName)) {
                        await append(ledger, {
                            type: "tool.denied",
                            timestamp: new Date().toISOString(),
                            sessionId: invocation.sessionId,
                            profile: activeRef.current.name,
                            classification: activeRef.current.classifications[0],
                            environment: activeRef.current.environment,
                            data: { toolName, reason: "profile-allow-list" },
                        });
                        return {
                            permissionDecision: "deny" as const,
                            permissionDecisionReason: "Tool is not allowed by the active governance profile.",
                        };
                    }
                    const anticipated = configuredToolClassification(policy.toolClassifications, toolName, activeRef.current)
                        ?? extractRequestedClassification(input.toolArgs, policy);
                    if (anticipated && !isClassificationSatisfied(policy, anticipated, activeRef.current)) {
                        await append(ledger, {
                            type: "tool.denied",
                            timestamp: new Date().toISOString(),
                            sessionId: invocation.sessionId,
                            profile: activeRef.current.name,
                            classification: activeRef.current.classifications[0],
                            environment: activeRef.current.environment,
                            data: { toolName, reason: "classification-not-reachable", anticipatedClassification: anticipated },
                        });
                        return {
                            permissionDecision: "deny" as const,
                            permissionDecisionReason: `Tool result classification '${anticipated}' is not reachable from the active governance profile.`,
                        };
                    }
                    return existingHooks?.onPreToolUse?.(input, invocation);
                },
            },
            onPermissionRequest: async (request: PermissionRequest, invocation: { sessionId: string }) => {
                const toolName = permissionToolName(request);
                if (toolName && !gate(toolName)) {
                    return { kind: "reject", feedback: "Tool is not allowed by the active governance profile." };
                }
                if (existingPermission) return existingPermission(request, invocation);
                return { kind: "approve-once" };
            },
        } as SessionConfig;
    }

    private async observe(event: SessionEvent): Promise<void> {
        if (event.type === "tool.execution_start") {
            this.toolNamesByCallId.set(event.data.toolCallId, event.data.toolName);
            return;
        }
        if (event.type === "session.model_change") {
            try {
                assertModelAllowed(this.active, event.data.newModel);
            } catch (error) {
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
            const data = event.data as unknown as Record<string, unknown>;
            const toolCallId = String(data.toolCallId ?? "");
            const toolName = this.toolNamesByCallId.get(toolCallId)
                ?? (data.toolDescription as { name?: string } | undefined)?.name
                ?? "unknown";
            const classification = extractClassification(data, this.policy)
                ?? configuredToolClassification(this.policy.toolClassifications, toolName, this.active);
            this.toolNamesByCallId.delete(toolCallId);
            await this.record("tool.completed", {
                toolName,
                resultClassification: classification,
            });
            if (classification && isHigherClassification(this.policy, classification, this.active)) {
                const target = profileForClassification(this.policy, classification);
                if (target) await this.upgradeTo(target, "classified-tool-result");
            }
        }
    }

    private async upgradeTo(target: GovernanceProfile, reason: string, details?: Record<string, unknown>): Promise<void> {
        const previous = this.active;
        this.active = target;
        if (this.activeRef) this.activeRef.current = target;
        if (target.model && target.model !== previous.model) {
            await this.session.setModel(target.model);
        }
        await this.record("profile.upgraded", {
            previousProfile: previous.name,
            newProfile: target.name,
            previousClassifications: previous.classifications,
            newClassifications: target.classifications,
            reason,
            ...details,
        });
        this.onClassificationChanged?.({ previous, current: target, reason });
    }

    private async record(type: string, data?: Record<string, unknown>): Promise<void> {
        await this.ledger?.append({
            type,
            timestamp: new Date().toISOString(),
            sessionId: this.session.sessionId,
            profile: this.active.name,
            classification: this.currentClassification(),
            environment: this.active.environment,
            data,
        });
    }
}

function normalizeToolName(toolName: string, profile?: GovernanceProfile): string {
    if (toolName.startsWith("mcp:") || toolName.startsWith("custom:") || toolName.startsWith("builtin:")) {
        return toolName;
    }
    if (toolName === "read_governance_policy" || toolName === "set_classification") {
        return `builtin:${toolName}`;
    }
    for (const serverName of Object.keys(profile?.mcpServers ?? {})) {
        if (toolName.startsWith(`${serverName}-`)) return `mcp:${toolName}`;
    }
    return toolName === "web_search" ? "builtin:web_search" : toolName;
}

function permissionToolName(request: PermissionRequest): string | undefined {
    const value = request as PermissionRequest & { toolName?: string; serverName?: string };
    if (request.kind === "custom-tool" && value.toolName) return `custom:${value.toolName}`;
    if (request.kind === "mcp" && value.toolName && value.serverName) {
        const name = value.toolName.startsWith(`${value.serverName}-`)
            ? value.toolName
            : `${value.serverName}-${value.toolName}`;
        return `mcp:${name}`;
    }
    return undefined;
}

function matchesPolicyQuery(query: string | undefined, profileName: string, classifications: string[]): boolean {
    if (!query) return true;
    const normalized = query.toLowerCase();
    return normalized.includes("all") || normalized.includes(profileName.toLowerCase()) || classifications.some((classification) => normalized.includes(classification.toLowerCase()));
}

function extractClassification(data: Record<string, unknown>, policy: GovernancePolicy): DataClassification | undefined {
    const result = data.result as Record<string, unknown> | undefined;
    const metadata = [result?._meta, result?.mcpMeta, data._meta, data.mcpMeta, data.toolTelemetry];
    for (const candidate of metadata) {
        const meta = candidate as Record<string, unknown> | undefined;
        const governance = meta?.governance as Record<string, unknown> | undefined;
        const value = governance?.classification ?? meta?.classification ?? governance?.sensitivity ?? meta?.sensitivity ?? meta?.ifc;
        if (typeof value === "string" && policy.classifications[value]) return value;
    }
    const content = [
        result?.content,
        result?.detailedContent,
        result?.structuredContent,
        result?.contents,
    ].map(stringifyResultContent).filter(Boolean).join("\n");
    const match = content.match(/(?:classification|data classification|sensitivity|information protection|confidentiality)\s*[:=-]\s*([A-Za-z0-9_-]+)/i);
    const value = match?.[1]?.trim();
    if (value && policy.classifications[value]) return value;
}

/** Reads an explicit classification/sensitivity argument off a tool call before it executes, so known-sensitive calls can be denied pre-flight instead of only evaluated after the result returns. */
function extractRequestedClassification(toolArgs: unknown, policy: GovernancePolicy): DataClassification | undefined {
    if (!toolArgs || typeof toolArgs !== "object") return undefined;
    const args = toolArgs as Record<string, unknown>;
    const value = args.classification ?? args.sensitivity;
    if (typeof value === "string" && policy.classifications[value]) return value;
}

function configuredToolClassification(
    toolClassifications: Record<string, DataClassification> | undefined,
    toolName: string,
    profile: GovernanceProfile,
): DataClassification | undefined {
    if (!toolClassifications) return undefined;
    const normalizedToolName = normalizeToolName(toolName, profile);
    return findConfiguredClassification(toolClassifications, toolName)
        ?? findConfiguredClassification(toolClassifications, normalizedToolName);
}

function findConfiguredClassification(
    toolClassifications: Record<string, DataClassification>,
    toolName: string,
): DataClassification | undefined {
    const exact = toolClassifications[toolName];
    if (exact) return exact;
    const wildcard = Object.entries(toolClassifications).find(([pattern]) =>
        pattern.endsWith("*") && toolName.startsWith(pattern.slice(0, -1))
    );
    return wildcard?.[1];
}

function stringifyResultContent(value: unknown): string {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
        return value.map((item) => {
            if (typeof item === "string") return item;
            if (item && typeof item === "object" && "text" in item && typeof item.text === "string") return item.text;
            return "";
        }).filter(Boolean).join("\n");
    }
    if (value && typeof value === "object") return JSON.stringify(value);
    return "";
}

function append(ledger: EvidenceLedger | undefined, record: EvidenceRecord): Promise<void> {
    return ledger?.append(record) ?? Promise.resolve();
}
