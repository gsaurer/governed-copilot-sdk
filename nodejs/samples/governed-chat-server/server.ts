import { CopilotClient } from "@github/copilot-sdk";
import { GovernedSession, LocalJsonlLedger, loadGovernanceConfig } from "governed-copilot-sdk-nodejs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const defaultConfigPath = fileURLToPath(new URL("../sample.governance.config.json", import.meta.url));
const configPath = resolve(process.env.GOVERNANCE_CONFIG ?? defaultConfigPath);
const port = Number(process.env.PORT ?? "8120");
const { policy, ledgerPath, sessionConfigFor } = await loadGovernanceConfig(configPath);
const sessions = new Map<string, ServerSession>();

interface ServerSession {
    governed: GovernedSession;
    events: Set<ServerResponse>;
    busy: boolean;
}

interface PublishedEvent {
    type: string;
    timestamp: string;
    data?: unknown;
}

const server = createServer(async (request, response) => {
    try {
        await route(request, response);
    } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
});

server.listen(port, "127.0.0.1", () => {
    console.log(`Governed chat server listening on http://127.0.0.1:${port}`);
    console.log(`Governance config: ${configPath}`);
    console.log("Session persistence: disabled (in-memory only)");
});

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (method === "GET" && url.pathname === "/health") return sendJson(response, 200, { status: "ok", sessions: sessions.size });
    if (method === "POST" && url.pathname === "/sessions") return createSession(request, response);

    const match = url.pathname.match(/^\/sessions\/([^/]+)(?:\/(events|messages))?$/);
    if (!match) return sendJson(response, 404, { error: "not_found" });
    const session = sessions.get(match[1]);
    if (!session) return sendJson(response, 404, { error: "session_not_found" });
    if (method === "GET" && match[2] === "events") return subscribe(session, request, response);
    if (method === "POST" && match[2] === "messages") return sendMessage(session, request, response);
    if (method === "DELETE" && !match[2]) return deleteSession(match[1], session, response);
    return sendJson(response, 405, { error: "method_not_allowed" });
}

async function createSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJson(request) as { profile?: string };
    const profile = body.profile ?? "public";
    if (!policy.profiles[profile]) return sendJson(response, 400, { error: "unknown_profile", profile });

    const client = new CopilotClient();
    let session: ServerSession | undefined;
    const governed = await GovernedSession.create({
        client,
        policy,
        profile,
        config: sessionConfigFor(profile),
        ledger: new LocalJsonlLedger(ledgerPath),
        onEvent: (event) => publish(session, event),
        onSensitivityChanged: ({ previous, current, reason }) => publish(session, {
            type: "governance.sensitivity_upgraded",
            timestamp: new Date().toISOString(),
            data: { previous: previous.sensitivity, current: current.sensitivity, profile: current.name, reason },
        }),
    });
    session = { governed, events: new Set(), busy: false };
    sessions.set(governed.sessionId, session);
    sendJson(response, 201, {
        sessionId: governed.sessionId,
        profile: governed.profile.name,
        sensitivity: governed.profile.sensitivity,
    });
}

async function sendMessage(session: ServerSession, request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (session.busy) return sendJson(response, 409, { error: "session_busy" });
    const body = await readJson(request) as { prompt?: string };
    if (!body.prompt?.trim()) return sendJson(response, 400, { error: "prompt_required" });
    session.busy = true;
    try {
        const result = await session.governed.sendAndWait<{ data?: { content?: string } }>({ prompt: body.prompt }, 180000);
        sendJson(response, 200, { content: result?.data?.content ?? "" });
    } catch (error) {
        sendJson(response, 504, { error: error instanceof Error ? error.message : String(error) });
    } finally {
        session.busy = false;
    }
}

function subscribe(session: ServerSession, request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, {
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream",
    });
    response.write(`event: ready\ndata: ${JSON.stringify({ sessionId: session.governed.sessionId })}\n\n`);
    session.events.add(response);
    request.on("close", () => session.events.delete(response));
}

async function deleteSession(id: string, session: ServerSession, response: ServerResponse): Promise<void> {
    session.events.forEach((client) => client.end());
    sessions.delete(id);
    await session.governed.disconnect();
    sendJson(response, 204, undefined);
}

function publish(session: ServerSession | undefined, event: PublishedEvent): void {
    if (!session) return;
    const projected = projectEvent(event);
    for (const client of session.events) {
        client.write(`event: ${projected.type}\ndata: ${JSON.stringify(projected)}\n\n`);
    }
}

function projectEvent(event: PublishedEvent): Record<string, unknown> {
    const data = event.data as Record<string, unknown> | undefined;
    const projected: Record<string, unknown> = { type: event.type, timestamp: event.timestamp };
    if (event.type === "assistant.message" || event.type === "assistant.reasoning") {
        projected.content = data?.content ?? data?.deltaContent ?? "";
    } else if (event.type === "tool.execution_start") {
        projected.tool = data?.toolName;
        projected.mcpServer = data?.mcpServerName;
    } else if (event.type === "session.model_change") {
        projected.previousModel = data?.previousModel;
        projected.newModel = data?.newModel;
    } else if (event.type === "tool.execution_complete") {
        projected.success = data?.success;
    }
    return projected;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        size += Buffer.byteLength(chunk);
        if (size > 1_000_000) throw new Error("request_too_large");
        chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
    response.statusCode = status;
    if (status === 204) {
        response.end();
        return;
    }
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(body));
}

process.on("SIGINT", async () => {
    await Promise.all([...sessions.values()].map(({ governed }) => governed.disconnect()));
    server.close();
});
