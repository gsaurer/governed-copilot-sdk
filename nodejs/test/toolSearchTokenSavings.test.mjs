import test from "node:test";
import assert from "node:assert/strict";

// A rough, tokenizer-free heuristic (not an exact token count) used only to compare
// the *relative* size of upfront tool-definition payloads with and without tool search.
// For an exact figure, read the session's real context/usage events against a live model.
const CHARS_PER_TOKEN = 4;

function makeSyntheticTool(index) {
    return {
        name: `mcp_server_tool_${index}`,
        description: `Performs operation #${index} against the backend service, handling pagination, filtering by status and date range, and returning a normalized result set for downstream consumers.`,
        input_schema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Free-text search query." },
                status: { type: "string", enum: ["open", "closed", "pending"] },
                startDate: { type: "string", format: "date" },
                endDate: { type: "string", format: "date" },
                limit: { type: "number", description: "Maximum number of results to return." },
            },
            required: ["query"],
        },
    };
}

function toolDefChars(tool) {
    return JSON.stringify(tool).length;
}

function estimateTokens(chars) {
    return Math.ceil(chars / CHARS_PER_TOKEN);
}

const SEARCH_TOOL_DEF_CHARS = toolDefChars({
    name: "tool_search_tool",
    description: "Search available tools by keyword. Only returns tools permitted by the active governance profile.",
    input_schema: {
        type: "object",
        properties: { query: { type: "string" }, limit: { type: "number" } },
        required: ["query"],
    },
});

/**
 * baseline: every tool's full definition is sent upfront on every turn.
 * withSearch: only `deferThreshold` tools are sent upfront; the rest are discovered
 * via one `tool_search_tool` call that returns at most `topK` full definitions.
 */
function simulate(totalTools, deferThreshold, topK) {
    const tools = Array.from({ length: totalTools }, (_, i) => makeSyntheticTool(i));
    const baselineChars = tools.reduce((sum, tool) => sum + toolDefChars(tool), 0);

    const deferred = totalTools > deferThreshold;
    const inlinedChars = (deferred ? tools.slice(0, deferThreshold) : tools)
        .reduce((sum, tool) => sum + toolDefChars(tool), 0);
    const searchResultChars = deferred
        ? tools.slice(0, Math.min(topK, totalTools)).reduce((sum, tool) => sum + toolDefChars(tool), 0)
        : 0;
    const withSearchChars = inlinedChars + SEARCH_TOOL_DEF_CHARS + searchResultChars;

    return {
        totalTools,
        baselineTokens: estimateTokens(baselineChars),
        withSearchTokens: estimateTokens(withSearchChars),
        reductionPct: Math.round((1 - withSearchChars / baselineChars) * 100),
    };
}

test("tool search materially reduces the upfront tool-catalog payload as tool count grows (heuristic estimate)", () => {
    const deferThreshold = 10;
    const topK = 5;
    const scenarios = [10, 30, 60, 120, 300].map((n) => simulate(n, deferThreshold, topK));

    console.log("\nEstimated tool-catalog payload (chars/4 \u2248 tokens heuristic; validate with real usage events for exact figures):");
    console.log("tools | baseline tokens | with-search tokens | reduction");
    for (const s of scenarios) {
        console.log(`${String(s.totalTools).padStart(5)} | ${String(s.baselineTokens).padStart(15)} | ${String(s.withSearchTokens).padStart(18)} | ${s.reductionPct}%`);
    }

    const atThreshold = scenarios[0];
    assert.ok(Math.abs(atThreshold.reductionPct) <= 10, `expected near-zero change at/below the defer threshold, got ${atThreshold.reductionPct}%`);

    const large = scenarios.at(-1);
    assert.ok(large.reductionPct >= 60, `expected >=60% reduction at ${large.totalTools} tools, got ${large.reductionPct}%`);

    for (let i = 1; i < scenarios.length; i++) {
        assert.ok(scenarios[i].reductionPct >= scenarios[i - 1].reductionPct, "reduction should grow (or hold) as tool count grows");
    }
});
