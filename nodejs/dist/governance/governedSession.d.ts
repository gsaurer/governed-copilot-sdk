import type { GovernedSessionOptions, GovernanceProfile, Sensitivity } from "./types.js";
export declare class GovernedSession {
    private readonly session;
    private readonly ledger?;
    private readonly policy;
    private readonly onSensitivityChanged?;
    private active;
    private readonly profiles;
    private activeRef?;
    private readonly toolNamesByCallId;
    private constructor();
    static create(options: GovernedSessionOptions): Promise<GovernedSession>;
    get sessionId(): string;
    get profile(): GovernanceProfile;
    sendAndWait<T = unknown>(...args: unknown[]): Promise<T>;
    setSensitivity(sensitivity: Sensitivity, reason?: string): Promise<void>;
    disconnect(): Promise<void>;
    private static withBuiltInGovernanceTools;
    private static withGovernanceHooks;
    private observe;
    private upgradeTo;
    private record;
}
