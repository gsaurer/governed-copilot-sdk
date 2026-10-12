import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
/** Reads, `${VAR:-default}`-expands, and validates a governance.config.json file. */
export async function loadGovernanceConfig(configPath) {
    return loadGovernanceConfigObject(JSON.parse(await readFile(configPath, "utf8")), configPath);
}
export function loadGovernanceConfigObject(document, sourcePath) {
    const raw = expandEnvironmentTemplates(document);
    validateGovernanceConfig(raw);
    const policy = {
        organization: raw.organization,
        policyName: raw.policyName,
        defaultProfile: raw.defaultProfile,
        profiles: toGovernanceProfiles(raw),
        classifications: raw.classifications,
        toolClassifications: raw.toolClassifications,
        modelClassification: raw.modelClassification,
        toolSearch: raw.toolSearch,
    };
    return {
        config: raw,
        policy,
        ledgerPath: resolveLedgerPath(raw, sourcePath),
        sessionConfigFor: (profileName) => createSessionConfig(raw, profileName, dirname(sourcePath)),
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
        classification: Object.entries(config.classifications).find((entry) => entry[1] === profileName)?.[0],
        model: resolveProfileModel(config, profile),
        providers,
        models,
        mcpServers: resolveProfileMcpServers(config, profile, baseDir),
        toolSearch: config.toolSearch,
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
