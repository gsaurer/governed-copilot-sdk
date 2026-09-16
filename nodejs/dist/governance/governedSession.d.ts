import type { GovernedSessionOptions, GovernanceProfile, DataClassification } from "./types.js";
export declare class GovernedSession {
    private readonly session;
    private readonly ledger?;
    private readonly policy;
    private readonly onClassificationChanged?;
    private active;
    private readonly profiles;
    private activeRef?;
    private readonly toolNamesByCallId;
    private constructor();
    static create(options: GovernedSessionOptions): Promise<GovernedSession>;
    get sessionId(): string;
    get profile(): GovernanceProfile;
    sendAndWait<T = unknown>(...args: unknown[]): Promise<T>;
    abort(): Promise<void>;
    setClassification(classification: DataClassification, reason?: string, details?: Record<string, unknown>): Promise<void>;
    private currentClassification;
    disconnect(reason?: string): Promise<void>;
    private static withBuiltInGovernanceTools;
    private static withGovernanceHooks;
    private observe;
    private upgradeTo;
    private record;
}
