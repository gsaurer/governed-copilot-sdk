#!/usr/bin/env node
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

// A broad, low-stakes tool catalog whose only purpose is to push the session's total
// tool count past the tool-search defer threshold (default 30), so `tool_search_tool`
// actually engages instead of every tool being loaded upfront.
const DOMAINS = [
  ["get_weather_forecast", "Look up a multi-day weather forecast for a city."],
  ["convert_currency", "Convert an amount from one currency to another using the latest rates."],
  ["translate_text", "Translate text between two languages."],
  ["get_stock_quote", "Fetch the latest quote for a stock ticker."],
  ["schedule_meeting", "Create a calendar meeting with attendees and a time slot."],
  ["lookup_timezone", "Look up the current time and UTC offset for a city."],
  ["geocode_address", "Convert a street address into latitude/longitude coordinates."],
  ["reverse_geocode", "Convert latitude/longitude coordinates into a street address."],
  ["send_sms", "Send a short text message to a phone number."],
  ["send_email", "Send an email with a subject and body."],
  ["create_task", "Create a to-do item with a due date."],
  ["search_flights", "Search flight options between two airports on a date."],
  ["search_hotels", "Search hotel availability in a city for a date range."],
  ["convert_units", "Convert a value between measurement units, e.g. miles to kilometers."],
  ["summarize_text", "Produce a short summary of a block of text."],
  ["extract_entities", "Extract named entities such as people, places, and dates from text."],
  ["generate_qr_code", "Generate a QR code image for a URL or text payload."],
  ["shorten_url", "Create a shortened redirect URL."],
  ["lookup_zip_code", "Look up city and state information for a postal/ZIP code."],
  ["calculate_mortgage", "Calculate a monthly mortgage payment from principal, rate, and term."],
  ["calculate_tip", "Calculate a tip and per-person split for a bill."],
  ["lookup_nutrition_facts", "Look up calorie and macro information for a food item."],
  ["convert_recipe_servings", "Scale a recipe's ingredient quantities to a new serving count."],
  ["lookup_word_definition", "Look up the dictionary definition of a word."],
  ["check_spelling", "Check a block of text for spelling errors."],
  ["generate_random_password", "Generate a random password meeting a complexity policy."],
  ["lookup_public_holiday", "Look up public holidays for a country and year."],
  ["convert_timezone", "Convert a timestamp from one timezone to another."],
  ["lookup_company_info", "Look up public profile information for a company by name or ticker."],
  ["search_news", "Search recent news articles by keyword."],
  ["lookup_traffic_conditions", "Look up current traffic conditions for a route."],
  ["calculate_bmi", "Calculate body mass index from height and weight."],
  ["lookup_air_quality", "Look up the current air quality index for a city."],
  ["generate_color_palette", "Generate a complementary color palette from a base color."],
  ["lookup_movie_showtimes", "Look up movie showtimes for a theater and date."],
];

const tools = DOMAINS.map(([name, description]) => ({
  name,
  description,
  inputSchema: { type: "object", properties: { query: { type: "string", description: "Free-text input for this tool." } }, required: ["query"] },
}));

const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") return send(message.id, { protocolVersion: message.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "catalog-demo", version: "0.1.0" } });
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") return send(message.id, { tools });
  if (message.method !== "tools/call") return send(message.id, { error: { code: -32601, message: `Method not found: ${message.method}` } });
  const name = message.params?.name;
  const args = message.params?.arguments ?? {};
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) return send(message.id, { error: { code: -32602, message: `Unknown tool: ${name}` } });
  const text = `[catalog-demo] ${name} called with query=${JSON.stringify(args.query ?? "")}. This is a synthetic tool for demonstrating tool search; it returns no real data.`;
  return send(message.id, { content: [{ type: "text", text }] });
});
