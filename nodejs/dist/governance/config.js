import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
/** Reads, `${VAR:-default}`-expands, and validates a governance.config.json file. */
export async function loadGovernanceConfig(configPath) {
    const raw = expandEnvironmentTemplates(JSON.parse(await readFile(configPath, "utf8")));
    validateGovernanceConfig(raw);
    const policy = { profiles: toGovernanceProfiles(raw), toolSensitivity: raw.toolSensitivity };
    return {
        config: raw,
        policy,
        ledgerPath: resolveLedgerPath(raw, configPath),
        sessionConfigFor: (profileName) => createSessionConfig(raw, profileName, dirname(configPath)),
    };
}
export function validateGovernanceConfig(config) {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
        throw new Error("configuration_must_be_an_object");
    }
    if (config.ledger && config.ledger.type !== "localFile") {
        throw new Error("ledger_type_must_be_localFile");
    }
    if (!config.executionEnvironments || typeof config.executionEnvironments !== "object") {
        throw new Error("executionEnvironments_is_required");
    }
    if (!config.profiles || typeof config.profiles !== "object") {
        throw new Error("profiles_is_required");
    }
    for (const [name, profile] of Object.entries(config.profiles)) {
        if (profile.sensitivity !== name) {
            throw new Error(`profile_${name}_sensitivity_must_match_its_key`);
        }
        if (typeof profile.environment !== "string" || !config.executionEnvironments[profile.environment]) {
            throw new Error(`profile_${name}_must_reference_a_configured_execution_environment`);
        }
    }
}
export function expandEnvironmentTemplates(value) {
    if (Array.isArray(value))
        return value.map(expandEnvironmentTemplates);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expandEnvironmentTemplates(child)]));
    }
    if (typeof value === "string") {
        return value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_match, name, fallback) => process.env[name] ?? fallback ?? "");
    }
    return value;
}
export function environmentFor(config, profile) {
    const environment = config.executionEnvironments[profile.environment];
    if (!environment)
        throw new Error(`Unknown execution environment '${profile.environment}'.`);
    return environment;
}
export function toGovernanceProfiles(config) {
    return Object.fromEntries(Object.entries(config.profiles).map(([name, profile]) => [name, {
            name,
            sensitivity: profile.sensitivity,
            environment: profile.environment,
            model: resolveProfileModel(config, profile),
            allowedModels: environmentFor(config, profile).models?.allow,
            deniedModels: resolveModelPolicyList(config, environmentFor(config, profile).models?.deny),
            tools: environmentFor(config, profile).tools?.allow,
            deniedTools: environmentFor(config, profile).tools?.deny,
            mcpServers: resolveProfileMcpServers(config, profile),
        }]));
}
export function resolveModelPolicyList(config, references) {
    return references?.map((reference) => {
        if (reference === "github/*")
            return "*";
        if (reference.endsWith("/*"))
            return reference;
        const [providerName, modelName] = reference.split("/");
        return config.models?.providers[providerName]?.models[modelName]?.id ?? reference;
    });
}
export function resolveProfileModel(config, profile) {
    const reference = environmentFor(config, profile).models?.allow?.[0];
    if (!reference)
        return undefined;
    if (reference.endsWith("/*"))
        return undefined;
    const [providerName, modelName] = reference.split("/");
    return config.models?.providers[providerName]?.models[modelName]?.id ?? reference;
}
export function resolveProfileMcpServers(config, profile, baseDir) {
    if (!config.mcpServers)
        return undefined;
    const allowed = environmentFor(config, profile).mcpServers?.allow ?? Object.keys(config.mcpServers);
    return Object.fromEntries(allowed.map((name) => [name, resolveMcpServer(config.mcpServers[name], baseDir)]));
}
export function resolveMcpServer(server, baseDir) {
    if (server.type !== "stdio" && server.type !== "local")
        return server;
    return {
        ...server,
        args: server.args?.map((arg) => (baseDir && arg.endsWith(".mjs") ? resolve(baseDir, arg).replaceAll("\\", "/") : arg)),
        workingDirectory: server.workingDirectory ?? baseDir,
    };
}
export function createSessionConfig(config, profileName, baseDir) {
    const profile = config.profiles[profileName];
    const environment = environmentFor(config, profile);
    const allowedModels = environment.models?.allow;
    const deniedModels = environment.models?.deny;
    const providers = [];
    const models = [];
    for (const [providerName, provider] of Object.entries(config.models?.providers ?? {})) {
        if (provider.type === "github")
            continue;
        const { models: providerModels, type, ...connection } = provider;
        for (const [modelName, model] of Object.entries(providerModels)) {
            const reference = `${providerName}/${modelName}`;
            if (!isConfiguredModelAllowed(reference, allowedModels, deniedModels))
                continue;
            if (!providers.some((candidate) => candidate.name === providerName)) {
                providers.push({ name: providerName, type, ...connection });
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
            });
        }
    }
    return {
        sensitivity: profile.sensitivity,
        model: resolveProfileModel(config, profile),
        providers,
        models,
        mcpServers: resolveProfileMcpServers(config, profile, baseDir),
    };
}
function isConfiguredModelAllowed(reference, allowed, denied) {
    if (denied?.some((pattern) => matchesModelReference(reference, pattern)))
        return false;
    return !allowed || allowed.some((pattern) => matchesModelReference(reference, pattern));
}
function matchesModelReference(reference, pattern) {
    return pattern === reference || pattern === "*" || (pattern.endsWith("/*") && reference.startsWith(pattern.slice(0, -1)));
}
function resolveLedgerPath(config, sourcePath) {
    const template = config.ledger?.pathTemplate ?? ".governance/evidence.jsonl";
    return isAbsolute(template) ? template : resolve(dirname(sourcePath), template);
}
