import {
    CopilotClient,
    defineTool,
    type MCPServerConfig,
    type NamedProviderConfig,
    type ProviderModelConfig,
    type SessionConfig,
} from "@github/copilot-sdk";
import { GovernedSession, LocalJsonlLedger, type Sensitivity } from "governed-copilot-sdk-nodejs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

type Config = {
    ledger?: { type: "localFile"; pathTemplate?: string };
    toolSensitivity?: Record<string, Sensitivity>;
    mcpServers?: Record<string, ConfiguredMcpServer>;
    models?: { providers: Record<string, ProviderCatalog> };
    executionEnvironments: Record<string, ExecutionEnvironmentConfig>;
    profiles: Record<string, ProfileConfig>;
};
type ProviderCatalog = { type: "github" | "openai" | "azure" | "anthropic"; baseUrl?: string; apiKey?: string; wireApi?: "completions" | "responses"; azure?: { apiVersion?: string }; models: Record<string, ModelCatalog> };
type ModelCatalog = { id: string; providerModelId?: string; modelId?: string; wireModel?: string; maxPromptTokens?: number; maxContextWindowTokens?: number; maxOutputTokens?: number; name?: string };
type ExecutionEnvironmentConfig = { models?: { allow?: string[]; deny?: string[] }; tools?: { allow?: string[]; deny?: string[] }; mcpServers?: { allow?: string[]; deny?: string[] } };
type ProfileConfig = { sensitivity: "public" | "internal" | "confidential" | "restricted"; environment: string; upgradeTargets?: string[] };
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
let waitingIndicator: WaitingIndicator | undefined;
let governedSession: GovernedSession | undefined;
await loadEnvironmentFile(join(dirname(configPath), ".env"));
const config = expandEnvironmentTemplates(JSON.parse(await readFile(configPath, "utf8")) as Config);
const policy = { profiles: toGovernanceProfiles(config), toolSensitivity: config.toolSensitivity };
const initialProfile = process.env.GOVERNED_PROFILE ?? "public";
const client = new CopilotClient();
const ledgerPath = resolveLedgerPath(config, configPath);
let activeModel = toGovernanceProfiles(config)[initialProfile]?.model ?? "runtime default";
governedSession = await GovernedSession.create({
    client,
    policy,
    profile: initialProfile,
    config: createSessionConfig(config, initialProfile),
    ledger: new LocalJsonlLedger(ledgerPath),
    onSensitivityChanged: ({ previous, current, reason }) => {
        if (info) {
            logInfo("sensitivity.upgrade", {
                previous: previous.sensitivity,
                current: current.sensitivity,
                profile: current.name,
                reason,
            });
        }
        logSystem(`Sensitivity upgraded to ${current.sensitivity} (profile=${current.name}; reason=${reason})`);
    },
    onEvent: (event) => {
        if (event.type === "session.model_change") {
            activeModel = event.data.newModel;
            if (info) {
                logInfo("session.model_change", {
                    previousModel: event.data.previousModel,
                    newModel: event.data.newModel,
                    cause: event.data.cause,
                });
            }
            logSystem(`Model changed to ${activeModel}`);
        }
        if (event.type === "tool.execution_start" && info) {
            logInfo("tool.execution_start", {
                tool: event.data.toolName,
                mcpServer: event.data.mcpServerName,
                mcpTool: event.data.mcpToolName,
                model: event.data.model,
            });
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

const governed = governedSession!;
const consoleReader = createInterface({ input, output });
console.log(`Governed chat using ${configPath}`);
console.log(`Profile: ${governed.profile.name} (${governed.profile.sensitivity})`);
console.log(`SessionId: ${governed.sessionId}`);
console.log(`Ledger: ${ledgerPath}`);
console.log(`${colors.yellow}System:${colors.reset} Sensitivity: ${governed.profile.sensitivity}; Model: ${activeModel}; Type /exit to quit.`);

try {
    while (true) {
        let prompt: string;
        if (input.readableEnded) break;
        try {
            prompt = await consoleReader.question(`${colors.cyan}You:${colors.reset} `);
        } catch (error) {
            if (isAbortError(error) || isReadlineClosedError(error)) break;
            throw error;
        }
        if (prompt.trim() === "/exit") break;
        if (!prompt.trim()) continue;
        const startedAt = Date.now();
        if (info) {
            logInfo("turn.start", {
                profile: governed.profile.name,
                sensitivity: governed.profile.sensitivity,
                model: activeModel,
                prompt,
            });
        }
        if (debug) console.error(`[debug turn.start profile=${governed.profile.name} prompt=${JSON.stringify(prompt)}]`);
        const indicator = startWaitingIndicator();
        waitingIndicator = indicator;
        try {
            const response = await governed.sendAndWait<{ data?: { content?: string } }>({ prompt });
            indicator.stop();
            console.log(`${colors.blue}Assistant:${colors.reset} ${response?.data?.content ?? ""}`);
            if (debug) console.error(`[debug turn.end elapsedMs=${Date.now() - startedAt}]`);
        } catch (error) {
            if (debug) console.error(`[debug turn.error elapsedMs=${Date.now() - startedAt} error=${error instanceof Error ? error.message : String(error)}]`);
            throw error;
        } finally {
            indicator.stop();
            waitingIndicator = undefined;
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

function isReadlineClosedError(error: unknown): boolean {
    return error instanceof Error && (error as NodeJS.ErrnoException).code === "ERR_USE_AFTER_CLOSE";
}

function logInfo(event: string, fields: Record<string, unknown>): void {
    const details = Object.entries(fields)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${typeof value === "string" ? JSON.stringify(value) : String(value)}`)
        .join(" ");
    writeChatLine(`${colors.yellow}[info event=${event}${details ? ` ${details}` : ""}]${colors.reset}`);
}

function logSystem(message: string): void {
    writeChatLine(`${colors.yellow}System:${colors.reset} ${message}`);
}

function writeChatLine(message: string): void {
    waitingIndicator?.clear();
    console.log(message);
    waitingIndicator?.refresh();
}

type WaitingIndicator = {
    clear: () => void;
    refresh: () => void;
    stop: () => void;
};

function startWaitingIndicator(): WaitingIndicator {
    const frames = ["|", "/", "-", "\\"];
    let frame = 0;
    let active = true;
    const render = () => {
        if (!active) return;
        process.stdout.write(`\r${colors.yellow}System:${colors.reset} Waiting for assistant ${frames[frame++ % frames.length]}`);
    };
    const clear = () => process.stdout.write("\r\x1b[2K");
    render();
    const timer = setInterval(render, 120);
    const stop = () => {
        if (!active) return;
        active = false;
        clearInterval(timer);
        clear();
    };
    return { clear, refresh: render, stop };
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
        environment: profile.environment,
        model: resolveProfileModel(config, profile),
        allowedModels: environmentFor(config, profile).models?.allow,
        deniedModels: resolveModelPolicyList(config, environmentFor(config, profile).models?.deny),
        tools: environmentFor(config, profile).tools?.allow,
        deniedTools: environmentFor(config, profile).tools?.deny,
        mcpServers: resolveProfileMcpServers(config, profile),
    }]));
}

function resolveModelPolicyList(config: Config, references: string[] | undefined): string[] | undefined {
    return references?.map((reference) => {
        if (reference === "github/*") return "*";
        if (reference.endsWith("/*")) return reference;
        const [providerName, modelName] = reference.split("/");
        return config.models?.providers[providerName]?.models[modelName]?.id ?? reference;
    });
}

function resolveProfileModel(config: Config, profile: ProfileConfig): string | undefined {
    const reference = environmentFor(config, profile).models?.allow?.[0];
    if (!reference) return undefined;
    if (reference.endsWith("/*")) return undefined;
    const [providerName, modelName] = reference.split("/");
    const model = config.models?.providers[providerName]?.models[modelName]?.id ?? reference;
    if (model.endsWith("/") && providerName === "foundry") {
        throw new Error(`Foundry model is not configured for profile '${profile.environment}'. Set FOUNDRY_MODEL in the sample .env file.`);
    }
    return model;
}

function resolveProfileMcpServers(config: Config, profile: ProfileConfig): Record<string, MCPServerConfig> | undefined {
    if (!config.mcpServers) return undefined;
    const allowed = environmentFor(config, profile).mcpServers?.allow ?? Object.keys(config.mcpServers);
    return Object.fromEntries(allowed.map((name) => [name, resolveMcpServer(config.mcpServers![name])])) as Record<string, MCPServerConfig>;
}

function environmentFor(config: Config, profile: ProfileConfig): ExecutionEnvironmentConfig {
    const environment = config.executionEnvironments[profile.environment];
    if (!environment) throw new Error(`Unknown execution environment '${profile.environment}'.`);
    return environment;
}

function resolveMcpServer(server: ConfiguredMcpServer): MCPServerConfig {
    if (server.type !== "stdio" && server.type !== "local") return server;
    return { ...server, command: server.command === "node" ? process.execPath : server.command, args: server.args?.map((arg) => arg.endsWith(".mjs") ? join(dirname(configPath), arg) : arg) } as MCPServerConfig;
}

function createSessionConfig(config: Config, profileName: string): SessionConfig {
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
            models.push({ id: model.providerModelId ?? model.id.replace(`${providerName}/`, "") ?? modelName, provider: providerName, modelId: model.modelId, wireModel: model.wireModel, maxPromptTokens: model.maxPromptTokens, maxContextWindowTokens: model.maxContextWindowTokens, maxOutputTokens: model.maxOutputTokens, name: model.name ?? modelName });
        }
    }
    return {
        sensitivity: profile.sensitivity,
        model: resolveProfileModel(config, profile),
        providers,
        models,
        mcpServers: resolveProfileMcpServers(config, profile),
        tools: [createGovernancePolicyTool(config)],
        systemMessage: {
            content: "Use the governance_policy tool to answer questions about the current session and configured profiles, sensitivity levels, allowed models, tools, and MCP servers. The governance_policy tool is read-only. Sensitivity is monotonic: never downgrade it, never claim a request to return to public succeeded, and never change governance configuration from chat. A sensitivity change occurs only when governance processes an explicit tool classification or an approved upward control. For requests about workplace context, meetings, documents, people, or project status, use the workiq MCP tools to gather context. Do not infer sensitivity for WorkIQ results unless the tool response explicitly supplies a label. For requests for sales data, call the internal-docs-get_sales_data MCP tool. For governance demonstrations, use internal-docs-get_internal_demo_data for Internal data and internal-docs-get_confidential_demo_data for Confidential data. When any tool response is explicitly marked Internal, Confidential, or Restricted in metadata or content, treat that label as authoritative and increase session sensitivity accordingly. Return the tool result to the user. Do not fabricate data or replace an available synthetic tool result with a refusal.",
        },
    } as SessionConfig;
}

function createGovernancePolicyTool(config: Config) {
    return defineTool("governance_policy", {
        description: "Read-only view of the current session state and loaded governance configuration. Use for questions about sensitivity levels, profiles, allowed models, tools, or MCP servers, including requests to lower sensitivity. Configuration changes and sensitivity downgrades are forbidden.",
        parameters: {
            type: "object",
            properties: {
                query: { type: "string", description: "Optional question or scope, such as 'internal', 'confidential', 'public profile', or 'all'." },
            },
        },
        skipPermission: true,
        handler: ({ query }: { query?: string }) => ({
            currentSession: governedSession ? {
                profile: governedSession.profile.name,
                sensitivity: governedSession.profile.sensitivity,
                environment: governedSession.profile.environment,
            } : undefined,
            sensitivityLevels: ["public", "internal", "confidential", "restricted"],
            profiles: Object.fromEntries(Object.entries(config.profiles)
                .filter(([name, profile]) => !query || matchesPolicyQuery(query, name, profile.sensitivity))
                .map(([name, profile]) => {
                    const environment = environmentFor(config, profile);
                    return [name, {
                        sensitivity: profile.sensitivity,
                        environment: profile.environment,
                        upgradeTargets: profile.upgradeTargets ?? [],
                        models: environment.models ?? {},
                        tools: environment.tools ?? {},
                        mcpServers: environment.mcpServers ?? {},
                    }];
                })),
            toolSensitivity: config.toolSensitivity ?? {},
            configuredProviders: Object.fromEntries(Object.entries(config.models?.providers ?? {}).map(([name, provider]) => [name, {
                type: provider.type,
                models: Object.keys(provider.models),
            }])),
            readOnly: true,
            query: query ?? "all",
        }),
    });
}

function matchesPolicyQuery(query: string, profileName: string, sensitivity: Sensitivity): boolean {
    const normalized = query.toLowerCase();
    return normalized.includes("all") || normalized.includes(profileName.toLowerCase()) || normalized.includes(sensitivity);
}

function isConfiguredModelAllowed(reference: string, allowed: string[] | undefined, denied: string[] | undefined): boolean {
    if (denied?.some((pattern) => matchesModelReference(reference, pattern))) return false;
    return !allowed || allowed.some((pattern) => matchesModelReference(reference, pattern));
}

function matchesModelReference(reference: string, pattern: string): boolean {
    return pattern === reference || pattern === "*" || pattern.endsWith("/*") && reference.startsWith(pattern.slice(0, -1));
}

function resolveLedgerPath(config: Config, sourcePath: string): string {
    const template = config.ledger?.pathTemplate ?? ".governance/evidence.jsonl";
    return isAbsolute(template) ? template : resolve(dirname(sourcePath), template);
}
