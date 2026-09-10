import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
export class LocalJsonlLedger {
    path;
    constructor(path) {
        this.path = path;
    }
    async append(record) {
        await mkdir(dirname(this.path), { recursive: true });
        const previousHash = await this.lastHash();
        const body = { ...record, previousHash };
        const hash = createHash("sha256").update(canonicalJson(body)).digest("hex");
        const stored = { ...body, hash };
        await appendFile(this.path, `${canonicalJson(stored)}\n`, "utf8");
    }
    async verify() {
        let previousHash = null;
        let content;
        try {
            content = await readFile(this.path, "utf8");
        }
        catch (error) {
            if (error.code === "ENOENT")
                return true;
            throw error;
        }
        for (const line of content.split(/\r?\n/).filter(Boolean)) {
            const record = JSON.parse(line);
            const { hash, ...body } = record;
            if (record.previousHash !== previousHash)
                return false;
            const expected = createHash("sha256").update(canonicalJson(body)).digest("hex");
            if (hash !== expected)
                return false;
            previousHash = hash;
        }
        return true;
    }
    async lastHash() {
        let content;
        try {
            content = await readFile(this.path, "utf8");
        }
        catch (error) {
            if (error.code === "ENOENT")
                return null;
            throw error;
        }
        const lines = content.split(/\r?\n/).filter(Boolean);
        return lines.length ? JSON.parse(lines[lines.length - 1]).hash : null;
    }
}
function canonicalJson(value) {
    if (Array.isArray(value))
        return `[${value.map((child) => child === undefined ? "null" : canonicalJson(child)).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.entries(value)
            .filter(([, child]) => child !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
            .join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}
