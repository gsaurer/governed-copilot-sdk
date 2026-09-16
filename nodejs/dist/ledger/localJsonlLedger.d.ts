import type { EvidenceLedger, EvidenceRecord } from "../governance/types.js";
interface StoredRecord extends EvidenceRecord {
    hash: string;
    previousHash: string | null;
}
export declare class LocalJsonlLedger implements EvidenceLedger {
    private readonly path;
    constructor(path: string);
    append(record: EvidenceRecord): Promise<void>;
    read(): Promise<StoredRecord[]>;
    verify(): Promise<boolean>;
    private lastHash;
}
export {};
