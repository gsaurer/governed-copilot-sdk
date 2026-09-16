import type { EvidenceLedger, EvidenceRecord } from "../governance/types.js";
/** Sends evidence records to a governance ledger endpoint instead of writing them locally. */
export declare class RemoteLedger implements EvidenceLedger {
    private readonly endpoint;
    private readonly options;
    constructor(endpoint: string, options?: {
        source?: string;
        onError?: (error: Error) => void;
    });
    append(record: EvidenceRecord): Promise<void>;
}
