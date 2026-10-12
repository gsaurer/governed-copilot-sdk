import type { MCPServerConfig, PermissionHandler, ProviderModelConfig, SessionConfig, SessionEvent } from "@github/copilot-sdk";
export type DataClassification = string;
export interface GovernanceProfile {
    name: string;
    classifications: string[];
    upgradeTargets: string[];
    environment?: string;
    model?: string;
    allowedModels?: string[];
    deniedModels?: string[];
    tools?: string[];
    deniedTools?: string[];
    mcpServers?: Record<string, MCPServerConfig>;
}
export interface GovernancePolicy {
    organization: string;
    policyName: string;
    defaultProfile: string;
    profiles: Record<string, GovernanceProfile>;
    classifications: Record<string, string>;
    toolClassifications?: Record<string, DataClassification>;
    modelClassification?: {
        enabled: boolean;
    };
    toolSearch?: {
        enabled?: boolean;
        deferThreshold?: number;
    };
}
export interface EvidenceRecord {
    type: string;
    timestamp: string;
    sessionId?: string;
    profile: string;
    classification?: DataClassification;
    environment?: string;
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
    onClassificationChanged?: (change: {
        previous: GovernanceProfile;
        current: GovernanceProfile;
        reason: string;
    }) => void;
}
export interface GovernedSdkSession {
    readonly sessionId: string;
    sendAndWait(...args: unknown[]): Promise<unknown>;
    abort(): Promise<void>;
    setModel(model: string): Promise<void>;
    on(handler: (event: SessionEvent) => void): () => void;
    disconnect(): Promise<void>;
}
export type PermissionHandlerLike = PermissionHandler;
