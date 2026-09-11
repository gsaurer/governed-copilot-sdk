import type { MCPServerConfig, SessionConfig } from "@github/copilot-sdk";
import type { GovernancePolicy, GovernanceProfile, Sensitivity } from "./types.js";
export type ProviderModelCatalogEntry = {
    id: string;
    providerModelId?: string;
    modelId?: string;
    wireModel?: string;
    maxPromptTokens?: number;
    maxContextWindowTokens?: number;
    maxOutputTokens?: number;
    name?: string;
};
export type ProviderCatalog = {
    type: "github" | "openai" | "azure" | "anthropic";
    baseUrl?: string;
    apiKey?: string;
    wireApi?: "completions" | "responses";
    azure?: {
        apiVersion?: string;
    };
    models: Record<string, ProviderModelCatalogEntry>;
};
export type ExecutionEnvironmentConfig = {
    models?: {
        allow?: string[];
        deny?: string[];
    };
    tools?: {
        allow?: string[];
        deny?: string[];
    };
    mcpServers?: {
        allow?: string[];
        deny?: string[];
    };
};
export type ProfileConfig = {
    sensitivity: Sensitivity;
    environment: string;
    upgradeTargets?: string[];
};
export type ConfiguredMcpServer = MCPServerConfig & {
    command?: string;
    args?: string[];
};
export type GovernanceConfigFile = {
    ledger?: {
        type: "localFile";
        pathTemplate?: string;
    };
    turnTimeoutMs?: number;
    toolSensitivity?: Record<string, Sensitivity>;
    mcpServers?: Record<string, ConfiguredMcpServer>;
    models?: {
        providers: Record<string, ProviderCatalog>;
    };
    executionEnvironments: Record<string, ExecutionEnvironmentConfig>;
    profiles: Record<string, ProfileConfig>;
};
/** Reads, `${VAR:-default}`-expands, and validates a governance.config.json file. */
export declare function loadGovernanceConfig(configPath: string): Promise<{
    config: GovernanceConfigFile;
    policy: GovernancePolicy;
    ledgerPath: string;
    sessionConfigFor: (profileName: string) => SessionConfig;
}>;
export declare function validateGovernanceConfig(config: GovernanceConfigFile): void;
export declare function expandEnvironmentTemplates(value: unknown): any;
export declare function environmentFor(config: GovernanceConfigFile, profile: ProfileConfig): ExecutionEnvironmentConfig;
export declare function toGovernanceProfiles(config: GovernanceConfigFile): Record<string, GovernanceProfile>;
export declare function resolveModelPolicyList(config: GovernanceConfigFile, references: string[] | undefined): string[] | undefined;
export declare function resolveProfileModel(config: GovernanceConfigFile, profile: ProfileConfig): string | undefined;
export declare function resolveProfileMcpServers(config: GovernanceConfigFile, profile: ProfileConfig, baseDir?: string): Record<string, MCPServerConfig> | undefined;
export declare function resolveMcpServer(server: ConfiguredMcpServer, baseDir?: string): MCPServerConfig;
export declare function createSessionConfig(config: GovernanceConfigFile, profileName: string, baseDir?: string): SessionConfig;
