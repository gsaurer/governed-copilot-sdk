import { CopilotClient, type SessionConfig } from "@github/copilot-sdk";
import { GovernedSession, LocalJsonlLedger, loadGovernanceConfig } from "governed-copilot-sdk-nodejs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const configPath = resolveConfigPath();
const info = process.argv.includes("--info");
const debug = process.argv.includes("--debug");
const colors = {
    cyan: "\x1b[36m",
    blue: "\x1b[34m",
    red: "\x1b[31m",
    yellow: "\x1b[33m",
    reset: "\x1b[0m",
};
let waitingIndicator: WaitingIndicator | undefined;
let governedSession: GovernedSession | undefined;
await loadEnvironmentFile(join(dirname(configPath), ".env"));
const { policy, ledgerPath, sessionConfigFor } = await loadGovernanceConfig(configPath);
const initialProfile = process.env.GOVERNED_PROFILE ?? "public";
const copilotStatePath = resolve(dirname(configPath), ".copilot-state");
const client = new CopilotClient({ baseDirectory: copilotStatePath, workingDirectory: dirname(configPath) });
let activeModel = policy.profiles[initialProfile]?.model ?? "runtime default";
governedSession = await GovernedSession.create({
    client,
    policy,
    profile: initialProfile,
    config: withAppSystemMessage(sessionConfigFor(initialProfile)),
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
        writeChatLine(`${colors.yellow}System:${colors.reset} ${colors.red}Sensitivity upgraded to ${current.sensitivity} (profile=${current.name}; reason=${reason})${colors.reset}`);
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
        if (event.type === "session.mcp_server_status_changed" && info) {
            logInfo("session.mcp_server_status_changed", {
                server: event.data.serverName,
                status: event.data.status,
                error: event.data.error,
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
console.log(`Copilot state: ${copilotStatePath}`);
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
    const value = equalsArg?.slice("--config=".length) ?? (separateIndex >= 0 ? args[separateIndex + 1] : undefined) ?? process.env.GOVERNANCE_CONFIG ?? "../sample.governance.config.json";
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

function withAppSystemMessage(config: SessionConfig): SessionConfig {
    return {
        ...config,
        systemMessage: {
            content: "A sensitivity change can also occur when governance processes an explicit tool classification. For requests about workplace context, meetings, documents, people, or project status, use the workiq MCP tools. Do not infer sensitivity for WorkIQ results unless the tool response explicitly supplies a label. For requests for sales data, call the internal-data-get_sales_data MCP tool. For governance demonstrations, use internal-data-get_internal_demo_data for Internal data and internal-data-get_confidential_demo_data for Confidential data. When any tool response is explicitly marked Internal, Confidential, or Restricted in metadata or content, treat that label as authoritative and increase session sensitivity accordingly. Return tool results to the user. Do not fabricate data or replace an available tool result with a refusal.",
        },
    };
}
