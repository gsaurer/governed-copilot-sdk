import type { MCPServerConfig, PermissionHandler, ProviderModelConfig, SessionConfig, SessionEvent } from "@github/copilot-sdk";
export type Sensitivity = "public" | "internal" | "confidential" | "restricted";
export interface GovernanceProfile {
    name: string;
    sensitivity: Sensitivity;
    model?: string;
    allowedModels?: string[];
    deniedModels?: string[];
    tools?: string[];
    deniedTools?: string[];
    mcpServers?: Record<string, MCPServerConfig>;
}
export interface GovernancePolicy {
    profiles: Record<string, GovernanceProfile>;
}
export interface EvidenceRecord {
    type: string;
    timestamp: string;
    sessionId?: string;
    profile: string;
    sensitivity: Sensitivity;
    data?: Record<string, unknown>;
}
export interface EvidenceLedger {
    append(record: EvidenceRecord): Promise<void>;
}
export interface GovernedSessionOptions {
    client: {
        createSession(config: SessionConfig): Promise<GovernedSdkSession>;
    };
    policy: GovernancePolicy;
    profile: string;
    ledger?: EvidenceLedger;
    config?: SessionConfig;
    modelDefinitions?: ProviderModelConfig[];
    onEvent?: (event: SessionEvent) => void;
    onSensitivityChanged?: (change: {
        previous: GovernanceProfile;
        current: GovernanceProfile;
        reason: string;
    }) => void;
}
export interface GovernedSdkSession {
    readonly sessionId: string;
    sendAndWait(...args: unknown[]): Promise<unknown>;
    setModel(model: string): Promise<void>;
    on(handler: (event: SessionEvent) => void): () => void;
    disconnect(): Promise<void>;
}
export type PermissionHandlerLike = PermissionHandler;
