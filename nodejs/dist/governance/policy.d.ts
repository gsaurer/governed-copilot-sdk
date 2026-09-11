import type { SessionConfig } from "@github/copilot-sdk";
import type { GovernancePolicy, GovernanceProfile, Sensitivity } from "./types.js";
export declare const sensitivityOrder: Sensitivity[];
export declare function getProfile(policy: GovernancePolicy, name: string): GovernanceProfile;
export declare function assertModelAllowed(profile: GovernanceProfile, model: string | undefined): void;
export declare function isHigherSensitivity(candidate: Sensitivity, current: Sensitivity): boolean;
export declare function matchesTool(toolName: string, filters: string[]): boolean;
export declare function applyProfile(config: SessionConfig, profile: GovernanceProfile): SessionConfig;
