import type { EvidenceLedger, EvidenceRecord } from "../governance/types.js";
export declare class LocalJsonlLedger implements EvidenceLedger {
    private readonly path;
    constructor(path: string);
    append(record: EvidenceRecord): Promise<void>;
    verify(): Promise<boolean>;
    private lastHash;
}
