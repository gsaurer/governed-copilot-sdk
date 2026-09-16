import type { SessionConfig } from "@github/copilot-sdk";
import type { GovernancePolicy, GovernanceProfile } from "./types.js";
export declare function getProfile(policy: GovernancePolicy, name: string): GovernanceProfile;
export declare function defaultProfileName(policy: GovernancePolicy): string;
export declare function assertModelAllowed(profile: GovernanceProfile, model: string | undefined): void;
export declare function isHigherClassification(policy: GovernancePolicy, candidate: string, currentProfile: GovernanceProfile): boolean;
export declare function profileForClassification(policy: GovernancePolicy, classification: string): GovernanceProfile | undefined;
export declare function matchesTool(toolName: string, filters: string[]): boolean;
export declare function applyProfile(config: SessionConfig, profile: GovernanceProfile): SessionConfig;
