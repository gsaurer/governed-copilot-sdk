#!/usr/bin/env node
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const tools = [
  { name: "search_internal_docs", description: "Search synthetic internal documentation.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "get_sales_data", description: "Use this tool whenever the user requests internal or confidential sales data. Set sensitivity to 'internal' for internal sales data and 'confidential' for confidential sales data. Returns synthetic classified sales data and governance metadata.", inputSchema: { type: "object", properties: { sensitivity: { type: "string", enum: ["internal", "confidential"] } }, required: ["sensitivity"] } },
  { name: "get_internal_demo_data", description: "Return synthetic data explicitly marked Internal for governance demonstration.", inputSchema: { type: "object", properties: {} } },
  { name: "get_confidential_demo_data", description: "Return synthetic data explicitly marked Confidential for governance demonstration.", inputSchema: { type: "object", properties: {} } },
];
const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);

const INTERNAL_GUIDANCE = "Internal sales information is non-public operational data for workforce and approved partners; do not publish it externally.";
const CLASSIFIED_GUIDANCE = "Confidential customer and revenue data may materially harm the company and customer relationships if disclosed. Access is limited to authorized personnel with a business need-to-know.";

const INTERNAL_SALES_DATA = `Sales data. Classification: internal. ${INTERNAL_GUIDANCE}\n\n| Account | Opportunity | Amount | Expected close |\n| --- | --- | ---: | --- |\n| Northwind | Renewal | $1.8M | 2026-09-30 |\n| Fabrikam | Expansion | $2.4M | 2026-10-15 |\n| Contoso | New logo | $950K | 2026-11-01 |`;

const CLASSIFIED_SALES_DATA = `Sales data. Classification: confidential. ${CLASSIFIED_GUIDANCE}\n\nSecurity tags: Need-to-know // Customer relationship risk // Revenue exposure // Deal-stage visibility restricted\n\n| Account | Opportunity | Amount | Expected close | Contact likelihood | Exposure |\n| --- | --- | ---: | --- | ---: | --- |\n| Northwind | Renewal | $1.8M | 2026-09-30 | 92% (High) | Strategic account, renewal at risk |\n| Fabrikam | Expansion | $2.4M | 2026-10-15 | 88% (High) | Cross-sell pipeline with C-suite visibility |\n| Contoso | New logo | $950K | 2026-11-01 | 61% (Medium) | Early-stage prospect with pricing pressure |`;
const INTERNAL_DEMO_DATA = "Internal: Synthetic workforce planning data. Headcount planning is limited to employees and approved partners.";
const CONFIDENTIAL_DEMO_DATA = "Confidential: Synthetic customer escalation data. Customer names and remediation details are restricted to authorized personnel.";

const guidance = (sensitivity) => sensitivity === "confidential" ? CLASSIFIED_GUIDANCE : INTERNAL_GUIDANCE;

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") return send(message.id, { protocolVersion: message.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "governed-chat-docs", version: "0.1.0" } });
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") return send(message.id, { tools });
  if (message.method !== "tools/call") return send(message.id, { error: { code: -32601, message: `Method not found: ${message.method}` } });
  const name = message.params?.name;
  const args = message.params?.arguments ?? {};
  const sensitivity = name === "get_sales_data"
    ? args.sensitivity
    : name === "get_confidential_demo_data"
      ? "confidential"
      : name === "get_internal_demo_data"
        ? "internal"
        : String(args.query ?? "").toLowerCase().includes("confidential") ? "confidential" : "internal";
  if (name === "get_sales_data" && !["internal", "confidential"].includes(sensitivity)) return send(message.id, { error: { code: -32602, message: "sensitivity must be internal or confidential" } });
  const text = name === "get_sales_data"
    ? sensitivity === "confidential" ? CLASSIFIED_SALES_DATA : INTERNAL_SALES_DATA
    : name === "get_internal_demo_data"
      ? INTERNAL_DEMO_DATA
      : name === "get_confidential_demo_data"
        ? CONFIDENTIAL_DEMO_DATA
        : `Internal documentation result. Classification: ${sensitivity}. ${guidance(sensitivity)}`;
  return send(message.id, { content: [{ type: "text", text }], _meta: { governance: { sensitivity, source: "governed-chat-sample" } } });
});
