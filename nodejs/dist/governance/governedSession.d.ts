import type { GovernedSessionOptions, GovernanceProfile, Sensitivity } from "./types.js";
export declare class GovernedSession {
    private readonly session;
    private readonly ledger?;
    private readonly policy;
    private active;
    private readonly profiles;
    private activeRef?;
    private constructor();
    static create(options: GovernedSessionOptions): Promise<GovernedSession>;
    get sessionId(): string;
    get profile(): GovernanceProfile;
    sendAndWait<T = unknown>(...args: unknown[]): Promise<T>;
    setSensitivity(sensitivity: Sensitivity): Promise<void>;
    disconnect(): Promise<void>;
    private static withGovernanceHooks;
    private observe;
    private upgradeTo;
    private record;
}
