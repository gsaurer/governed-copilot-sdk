import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type {
    MCPServerConfig,
    NamedProviderConfig,
    ProviderModelConfig,
    SessionConfig,
} from "@github/copilot-sdk";
import type { GovernancePolicy, GovernanceProfile, DataClassification } from "./types.js";

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
    azure?: { apiVersion?: string };
    models: Record<string, ProviderModelCatalogEntry>;
};
export type ExecutionEnvironmentConfig = {
    models?: { allow?: string[]; deny?: string[] };
    tools?: { allow?: string[]; deny?: string[] };
    mcpServers?: { allow?: string[]; deny?: string[] };
};
export type ProfileConfig = { environment: string; upgradeTargets?: string[] };
export type ConfiguredMcpServer = MCPServerConfig & { command?: string; args?: string[] };
export type GovernanceConfigFile = {
    organization: string;
    policyName: string;
    ledger?: { type: "localFile"; pathTemplate?: string };
    turnTimeoutMs?: number;
    defaultProfile: string;
    classifications: Record<string, string>;
    toolClassifications?: Record<string, DataClassification>;
    modelClassification?: { enabled: boolean };
    mcpServers?: Record<string, ConfiguredMcpServer>;
    models?: { providers: Record<string, ProviderCatalog> };
    executionEnvironments: Record<string, ExecutionEnvironmentConfig>;
    profiles: Record<string, ProfileConfig>;
};

/** Reads, `${VAR:-default}`-expands, and validates a governance.config.json file. */
export async function loadGovernanceConfig(configPath: string): Promise<{
    config: GovernanceConfigFile;
    policy: GovernancePolicy;
    ledgerPath: string;
    sessionConfigFor: (profileName: string) => SessionConfig;
}> {
    return loadGovernanceConfigObject(JSON.parse(await readFile(configPath, "utf8")), configPath);
}

export function loadGovernanceConfigObject(document: unknown, sourcePath: string): {
    config: GovernanceConfigFile;
    policy: GovernancePolicy;
    ledgerPath: string;
    sessionConfigFor: (profileName: string) => SessionConfig;
} {
    const raw = expandEnvironmentTemplates(document) as GovernanceConfigFile;
    validateGovernanceConfig(raw);
    const policy = {
        organization: raw.organization,
        policyName: raw.policyName,
        defaultProfile: raw.defaultProfile,
        profiles: toGovernanceProfiles(raw),
        classifications: raw.classifications,
        toolClassifications: raw.toolClassifications,
        modelClassification: raw.modelClassification,
    };
    return {
        config: raw,
        policy,
        ledgerPath: resolveLedgerPath(raw, sourcePath),
        sessionConfigFor: (profileName: string) => createSessionConfig(raw, profileName, dirname(sourcePath)),
    };
}

export function validateGovernanceConfig(config: GovernanceConfigFile): void {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
        throw new Error("configuration_must_be_an_object");
    }
    if (config.ledger && config.ledger.type !== "localFile") {
        throw new Error("ledger_type_must_be_localFile");
    }
    if (!config.executionEnvironments || typeof config.executionEnvironments !== "object") {
        throw new Error("executionEnvironments_is_required");
    }
    if (typeof config.organization !== "string" || !config.organization.trim()) {
        throw new Error("organization_is_required");
    }
    if (typeof config.policyName !== "string" || !config.policyName.trim()) {
        throw new Error("policyName_is_required");
    }
    if (!config.profiles || typeof config.profiles !== "object") {
        throw new Error("profiles_is_required");
    }
    if (typeof config.defaultProfile !== "string" || !config.profiles[config.defaultProfile]) {
        throw new Error("defaultProfile_must_reference_a_configured_profile");
    }
    if (!config.classifications || typeof config.classifications !== "object") {
        throw new Error("classifications_is_required");
    }
    for (const [classification, profileName] of Object.entries(config.classifications)) {
        if (typeof profileName !== "string" || !config.profiles[profileName]) {
            throw new Error(`classification_${classification}_must_reference_a_configured_profile`);
        }
    }
    for (const [name, profile] of Object.entries(config.profiles)) {
        if (typeof profile.environment !== "string" || !config.executionEnvironments[profile.environment]) {
            throw new Error(`profile_${name}_must_reference_a_configured_execution_environment`);
        }
        if (profile.upgradeTargets?.some((target) => !config.profiles[target])) {
            throw new Error(`profile_${name}_upgradeTargets_must_reference_configured_profiles`);
        }
    }
}

export function expandEnvironmentTemplates(value: unknown): any {
    if (Array.isArray(value)) return value.map(expandEnvironmentTemplates);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expandEnvironmentTemplates(child)]));
    }
    if (typeof value === "string") {
        return value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_match, name, fallback) => process.env[name] ?? fallback ?? "");
    }
    return value;
}

export function environmentFor(config: GovernanceConfigFile, profile: ProfileConfig): ExecutionEnvironmentConfig {
    const environment = config.executionEnvironments[profile.environment];
    if (!environment) throw new Error(`Unknown execution environment '${profile.environment}'.`);
    return environment;
}

export function toGovernanceProfiles(config: GovernanceConfigFile): Record<string, GovernanceProfile> {
    return Object.fromEntries(Object.entries(config.profiles).map(([name, profile]) => [name, {
        name,
        classifications: Object.entries(config.classifications)
            .filter(([, profileName]) => profileName === name)
            .map(([classification]) => classification),
        upgradeTargets: profile.upgradeTargets ?? [],
        environment: profile.environment,
        model: resolveProfileModel(config, profile),
        allowedModels: environmentFor(config, profile).models?.allow,
        deniedModels: resolveModelPolicyList(config, environmentFor(config, profile).models?.deny),
        tools: environmentFor(config, profile).tools?.allow,
        deniedTools: environmentFor(config, profile).tools?.deny,
        mcpServers: resolveProfileMcpServers(config, profile),
    } as GovernanceProfile]));
}

export function resolveModelPolicyList(config: GovernanceConfigFile, references: string[] | undefined): string[] | undefined {
    return references?.map((reference) => {
        if (reference === "github/*") return "*";
        if (reference.endsWith("/*")) return reference;
        const [providerName, modelName] = reference.split("/");
        return config.models?.providers[providerName]?.models[modelName]?.id ?? reference;
    });
}

export function resolveProfileModel(config: GovernanceConfigFile, profile: ProfileConfig): string | undefined {
    const reference = environmentFor(config, profile).models?.allow?.[0];
    if (!reference) return undefined;
    if (reference.endsWith("/*")) return undefined;
    const [providerName, modelName] = reference.split("/");
    return config.models?.providers[providerName]?.models[modelName]?.id ?? reference;
}

export function resolveProfileMcpServers(config: GovernanceConfigFile, profile: ProfileConfig, baseDir?: string): Record<string, MCPServerConfig> | undefined {
    if (!config.mcpServers) return undefined;
    const allowed = environmentFor(config, profile).mcpServers?.allow ?? Object.keys(config.mcpServers);
    return Object.fromEntries(allowed.map((name) => [name, resolveMcpServer(config.mcpServers![name], baseDir)])) as Record<string, MCPServerConfig>;
}

export function resolveMcpServer(server: ConfiguredMcpServer, baseDir?: string): MCPServerConfig {
    if (server.type !== "stdio" && server.type !== "local") return server;
    return {
        ...server,
        args: server.args?.map((arg) => (baseDir && arg.endsWith(".mjs") ? resolve(baseDir, arg).replaceAll("\\", "/") : arg)),
        workingDirectory: server.workingDirectory ?? baseDir,
    } as MCPServerConfig;
}

export function createSessionConfig(config: GovernanceConfigFile, profileName: string, baseDir?: string): SessionConfig {
    const profile = config.profiles[profileName];
    const environment = environmentFor(config, profile);
    const allowedModels = environment.models?.allow;
    const deniedModels = environment.models?.deny;
    const providers: NamedProviderConfig[] = [];
    const models: ProviderModelConfig[] = [];
    for (const [providerName, provider] of Object.entries(config.models?.providers ?? {})) {
        if (provider.type === "github") continue;
        const { models: providerModels, type, ...connection } = provider;
        for (const [modelName, model] of Object.entries(providerModels)) {
            const reference = `${providerName}/${modelName}`;
            if (!isConfiguredModelAllowed(reference, allowedModels, deniedModels)) continue;
            if (!providers.some((candidate) => candidate.name === providerName)) {
                providers.push({ name: providerName, type, ...connection } as NamedProviderConfig);
            }
            models.push({
                id: model.providerModelId ?? model.id.replace(`${providerName}/`, "") ?? modelName,
                provider: providerName,
                modelId: model.modelId,
                wireModel: model.wireModel,
                maxPromptTokens: model.maxPromptTokens,
                maxContextWindowTokens: model.maxContextWindowTokens,
                maxOutputTokens: model.maxOutputTokens,
                name: model.name ?? modelName,
            } as ProviderModelConfig);
        }
    }
    return {
        classification: Object.entries(config.classifications).find((entry) => entry[1] === profileName)?.[0],
        model: resolveProfileModel(config, profile),
        providers,
        models,
        mcpServers: resolveProfileMcpServers(config, profile, baseDir),
    } as SessionConfig;
}

function isConfiguredModelAllowed(reference: string, allowed: string[] | undefined, denied: string[] | undefined): boolean {
    if (denied?.some((pattern) => matchesModelReference(reference, pattern))) return false;
    return !allowed || allowed.some((pattern) => matchesModelReference(reference, pattern));
}

function matchesModelReference(reference: string, pattern: string): boolean {
    return pattern === reference || pattern === "*" || (pattern.endsWith("/*") && reference.startsWith(pattern.slice(0, -1)));
}

function resolveLedgerPath(config: GovernanceConfigFile, sourcePath: string): string {
    const template = config.ledger?.pathTemplate ?? ".governance/evidence.jsonl";
    return isAbsolute(template) ? template : resolve(dirname(sourcePath), template);
}
