import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EvidenceLedger, EvidenceRecord } from "../governance/types.js";

interface StoredRecord extends EvidenceRecord {
    hash: string;
    previousHash: string | null;
}

export class LocalJsonlLedger implements EvidenceLedger {
    public constructor(private readonly path: string) {}

    public async append(record: EvidenceRecord): Promise<void> {
        await mkdir(dirname(this.path), { recursive: true });
        const previousHash = await this.lastHash();
        const body = { ...record, previousHash };
        const hash = createHash("sha256").update(canonicalJson(body)).digest("hex");
        const stored: StoredRecord = { ...body, hash };
        await appendFile(this.path, `${canonicalJson(stored)}\n`, "utf8");
    }

    public async verify(): Promise<boolean> {
        let previousHash: string | null = null;
        let content: string;
        try {
            content = await readFile(this.path, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
            throw error;
        }
        for (const line of content.split(/\r?\n/).filter(Boolean)) {
            const record = JSON.parse(line) as StoredRecord;
            const { hash, ...body } = record;
            if (record.previousHash !== previousHash) return false;
            const expected = createHash("sha256").update(canonicalJson(body)).digest("hex");
            if (hash !== expected) return false;
            previousHash = hash;
        }
        return true;
    }

    private async lastHash(): Promise<string | null> {
        let content: string;
        try {
            content = await readFile(this.path, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
        }
        const lines = content.split(/\r?\n/).filter(Boolean);
        return lines.length ? (JSON.parse(lines[lines.length - 1]) as StoredRecord).hash : null;
    }
}

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map((child) => child === undefined ? "null" : canonicalJson(child)).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.entries(value as Record<string, unknown>)
            .filter(([, child]) => child !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
            .join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}
