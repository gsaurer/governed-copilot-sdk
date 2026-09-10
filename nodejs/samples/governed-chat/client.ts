import {
    CopilotClient,
    defineTool,
    type MCPServerConfig,
    type NamedProviderConfig,
    type ProviderModelConfig,
    type SessionConfig,
} from "@github/copilot-sdk";
import { GovernedSession, LocalJsonlLedger } from "governed-copilot-sdk-nodejs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

type Config = {
    ledger?: { type: "localFile"; pathTemplate?: string };
    customTools?: string[];
    mcpServers?: Record<string, ConfiguredMcpServer>;
    models?: { providers: Record<string, ProviderCatalog> };
    profiles: Record<string, ProfileConfig>;
};
type ProviderCatalog = { type: "github" | "openai" | "azure" | "anthropic"; baseUrl?: string; apiKey?: string; wireApi?: "completions" | "responses"; azure?: { apiVersion?: string }; models: Record<string, ModelCatalog> };
type ModelCatalog = { id: string; providerModelId?: string; modelId?: string; wireModel?: string; maxPromptTokens?: number; maxContextWindowTokens?: number; maxOutputTokens?: number; name?: string };
type ProfileConfig = { sensitivity: "public" | "internal" | "confidential" | "restricted"; models?: { allow?: string[]; deny?: string[] }; tools?: { allow?: string[]; deny?: string[] }; mcpServers?: { allow?: string[]; deny?: string[] } };
type ConfiguredMcpServer = MCPServerConfig & { command?: string; args?: string[] };

const configPath = resolveConfigPath();
const info = process.argv.includes("--info");
const debug = process.argv.includes("--debug");
const colors = {
    cyan: "\x1b[36m",
    blue: "\x1b[34m",
    yellow: "\x1b[33m",
    reset: "\x1b[0m",
};
await loadEnvironmentFile(join(dirname(configPath), ".env"));
const config = expandEnvironmentTemplates(JSON.parse(await readFile(configPath, "utf8")) as Config);
const policy = { profiles: toGovernanceProfiles(config) };
const initialProfile = process.env.GOVERNED_PROFILE ?? "public";
const client = new CopilotClient();
const ledgerPath = resolveLedgerPath(config, configPath);
let activeModel = toGovernanceProfiles(config)[initialProfile]?.model ?? "runtime default";
const governed = await GovernedSession.create({
    client,
    policy,
    profile: initialProfile,
    config: createSessionConfig(config, initialProfile),
    ledger: new LocalJsonlLedger(ledgerPath),
    onEvent: (event) => {
        if (event.type === "session.model_change") {
            activeModel = event.data.newModel;
            console.log(`${colors.blue}[model: ${activeModel}]${colors.reset}`);
        }
        if (!debug) return;
        const data = event.data as Record<string, unknown> | undefined;
        const details = [
            data?.model ? `model=${String(data.model)}` : "",
            data?.newModel ? `newModel=${String(data.newModel)}` : "",
            data?.toolName ? `tool=${String(data.toolName)}` : "",
            data?.message ? `message=${String(data.message)}` : "",
        ].filter(Boolean).join(" ");
        console.error(`[debug event=${event.type}${details ? ` ${details}` : ""}]`);
    },
});

const consoleReader = createInterface({ input, output });
console.log(`Governed chat using ${configPath}`);
console.log(`Profile: ${governed.profile.name} (${governed.profile.sensitivity})`);
console.log(`SessionId: ${governed.sessionId}`);
console.log(`Ledger: ${ledgerPath}`);
console.log(`Model: ${activeModel}`);
console.log(`Info: ${info ? "enabled" : "disabled"}; Debug: ${debug ? "enabled" : "disabled"}`);
console.log("Type /exit to quit.");

try {
    while (true) {
        let prompt: string;
        try {
            prompt = await consoleReader.question("You: ");
        } catch (error) {
            if (isAbortError(error)) break;
            throw error;
        }
        if (prompt.trim() === "/exit") break;
        if (!prompt.trim()) continue;
        const startedAt = Date.now();
        console.log(`${colors.cyan}[turn profile=${governed.profile.name} sensitivity=${governed.profile.sensitivity} model=${activeModel}]${colors.reset}`);
        if (debug) console.error(`[debug turn.start profile=${governed.profile.name} prompt=${JSON.stringify(prompt)}]`);
        try {
            const response = await governed.sendAndWait<{ data?: { content?: string } }>({ prompt });
            console.log(`Assistant: ${response?.data?.content ?? ""}`);
            if (debug) console.error(`[debug turn.end elapsedMs=${Date.now() - startedAt}]`);
        } catch (error) {
            if (debug) console.error(`[debug turn.error elapsedMs=${Date.now() - startedAt} error=${error instanceof Error ? error.message : String(error)}]`);
            throw error;
        }
    }
} finally {
    consoleReader.close();
    await governed.disconnect();
    await client.stop();
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && (error.name === "AbortError" || (error as NodeJS.ErrnoException).code === "ABORT_ERR");
}

function resolveConfigPath(): string {
    const args = process.argv.slice(2);
    const equalsArg = args.find((arg) => arg.startsWith("--config="));
    const separateIndex = args.indexOf("--config");
    const value = equalsArg?.slice("--config=".length) ?? (separateIndex >= 0 ? args[separateIndex + 1] : undefined) ?? process.env.GOVERNANCE_CONFIG ?? "governance.config.json";
    return resolve(process.cwd(), value);
}

async function loadEnvironmentFile(path: string): Promise<void> {
    try {
        const content = await readFile(path, "utf8");
        for (const line of content.split(/\r?\n/)) {
            const match = line.trim().match(/^([A-Z0-9_]+)=(.*)$/);
            if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}

function expandEnvironmentTemplates(value: unknown): any {
    if (Array.isArray(value)) return value.map(expandEnvironmentTemplates);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expandEnvironmentTemplates(child)]));
    if (typeof value === "string") return value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_match, name, fallback) => process.env[name] ?? fallback ?? "");
    return value;
}

function toGovernanceProfiles(config: Config) {
    return Object.fromEntries(Object.entries(config.profiles).map(([name, profile]) => [name, {
        name,
        sensitivity: profile.sensitivity,
        model: resolveProfileModel(config, profile),
        tools: profile.tools?.allow,
        deniedTools: profile.tools?.deny,
        mcpServers: resolveProfileMcpServers(config, profile),
    }]));
}

function resolveProfileModel(config: Config, profile: ProfileConfig): string | undefined {
    const reference = profile.models?.allow?.[0];
    if (!reference) return undefined;
    const [providerName, modelName] = reference.split("/");
    return config.models?.providers[providerName]?.models[modelName]?.id ?? reference;
}

function resolveProfileMcpServers(config: Config, profile: ProfileConfig): Record<string, MCPServerConfig> | undefined {
    if (!config.mcpServers) return undefined;
    const allowed = profile.mcpServers?.allow ?? Object.keys(config.mcpServers);
    return Object.fromEntries(allowed.map((name) => [name, resolveMcpServer(config.mcpServers![name])])) as Record<string, MCPServerConfig>;
}

function resolveMcpServer(server: ConfiguredMcpServer): MCPServerConfig {
    if (server.type !== "stdio" && server.type !== "local") return server;
    return { ...server, command: server.command === "node" ? process.execPath : server.command, args: server.args?.map((arg) => arg.endsWith(".mjs") ? join(dirname(configPath), arg) : arg) } as MCPServerConfig;
}

function createSessionConfig(config: Config, profileName: string): SessionConfig {
    const profile = config.profiles[profileName];
    const providers: NamedProviderConfig[] = [];
    const models: ProviderModelConfig[] = [];
    for (const [providerName, provider] of Object.entries(config.models?.providers ?? {})) {
        if (provider.type === "github") continue;
        const { models: providerModels, type, ...connection } = provider;
        providers.push({ name: providerName, type, ...connection } as NamedProviderConfig);
        for (const [modelName, model] of Object.entries(providerModels)) {
            models.push({ id: model.providerModelId ?? model.id.replace(`${providerName}/`, "") ?? modelName, provider: providerName, modelId: model.modelId, wireModel: model.wireModel, maxPromptTokens: model.maxPromptTokens, maxContextWindowTokens: model.maxContextWindowTokens, maxOutputTokens: model.maxOutputTokens, name: model.name ?? modelName });
        }
    }
    return { model: resolveProfileModel(config, profile), providers, models, mcpServers: resolveProfileMcpServers(config, profile), tools: resolveCustomTools(config.customTools) } as SessionConfig;
}

function resolveCustomTools(names: string[] | undefined) {
    return (names ?? []).map((name) => {
        if (name === "public_status") return defineTool(name, { description: "Returns public service status.", parameters: { type: "object", properties: {} }, handler: () => ({ textResultForLlm: "All public services are operational.", resultType: "success" }) });
        if (name === "internal_ticket_lookup") return defineTool(name, { description: "Returns synthetic internal ticket data.", parameters: { type: "object", properties: { id: { type: "string" } } }, handler: () => ({ textResultForLlm: "Synthetic internal ticket data. Classification: internal.", resultType: "success" }) });
        throw new Error(`No sample implementation exists for configured custom tool '${name}'.`);
    });
}

function resolveLedgerPath(config: Config, sourcePath: string): string {
    const template = config.ledger?.pathTemplate ?? ".governance/evidence.jsonl";
    return isAbsolute(template) ? template : resolve(dirname(sourcePath), template);
}
