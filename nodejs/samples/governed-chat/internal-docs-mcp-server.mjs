#!/usr/bin/env node
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const tools = [
  { name: "search_internal_docs", description: "Search synthetic internal documentation.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "get_sales_data", description: "Use this tool whenever the user requests internal or confidential sales data. Set sensitivity to 'internal' for internal sales data and 'confidential' for confidential sales data. Returns synthetic classified sales data and governance metadata.", inputSchema: { type: "object", properties: { sensitivity: { type: "string", enum: ["internal", "confidential"] } }, required: ["sensitivity"] } },
];
const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const guidance = (sensitivity) => sensitivity === "confidential"
  ? "Confidential information may materially harm the organization if disclosed; restrict it to authorized participants and approved endpoints."
  : "Internal information is non-public operational information for workforce and approved partners; do not publish it externally.";

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") return send(message.id, { protocolVersion: message.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "governed-chat-docs", version: "0.1.0" } });
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") return send(message.id, { tools });
  if (message.method !== "tools/call") return send(message.id, { error: { code: -32601, message: `Method not found: ${message.method}` } });
  const name = message.params?.name;
  const args = message.params?.arguments ?? {};
  const sensitivity = name === "get_sales_data" ? args.sensitivity : String(args.query ?? "").toLowerCase().includes("confidential") ? "confidential" : "internal";
  if (name === "get_sales_data" && !["internal", "confidential"].includes(sensitivity)) return send(message.id, { error: { code: -32602, message: "sensitivity must be internal or confidential" } });
  const text = name === "get_sales_data"
    ? `Sales data. Classification: ${sensitivity}. ${guidance(sensitivity)}\n\n| Account | Opportunity | Amount | Expected close |\n| --- | --- | ---: | --- |\n| Northwind | Renewal | $1.8M | 2026-09-30 |\n| Fabrikam | Expansion | $2.4M | 2026-10-15 |\n| Contoso | New logo | $950K | 2026-11-01 |`
    : `Internal documentation result. Classification: ${sensitivity}. ${guidance(sensitivity)}`;
  return send(message.id, { content: [{ type: "text", text }], _meta: { governance: { sensitivity, source: "governed-chat-sample" } } });
});
