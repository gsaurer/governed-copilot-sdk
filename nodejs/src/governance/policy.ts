import type { SessionConfig } from "@github/copilot-sdk";
import type { GovernancePolicy, GovernanceProfile, Sensitivity } from "./types.js";

const sensitivityOrder: Sensitivity[] = ["public", "internal", "confidential", "restricted"];

export function getProfile(policy: GovernancePolicy, name: string): GovernanceProfile {
    const profile = policy.profiles[name];
    if (!profile) throw new Error(`Unknown governance profile '${name}'.`);
    return profile;
}

export function assertModelAllowed(profile: GovernanceProfile, model: string | undefined): void {
    if (!model) return;
    if (profile.deniedModels?.some((pattern) => matchesModel(model, pattern))) {
        throw new Error(`Model '${model}' is denied by profile '${profile.name}'.`);
    }
    if (profile.allowedModels && !profile.allowedModels.some((pattern) => matchesModel(model, pattern))) {
        throw new Error(`Model '${model}' is not allowed by profile '${profile.name}'.`);
    }
}

export function isHigherSensitivity(candidate: Sensitivity, current: Sensitivity): boolean {
    return sensitivityOrder.indexOf(candidate) > sensitivityOrder.indexOf(current);
}

export function matchesTool(toolName: string, filters: string[]): boolean {
    return filters.some((filter) =>
        filter === toolName || (filter.endsWith(":*") && toolName.startsWith(filter.slice(0, -1)))
    );
}

function matchesModel(model: string, pattern: string): boolean {
    if (pattern === "github/*") return !model.includes("/");
    return pattern === "*" || model === pattern || pattern.endsWith("*") && model.startsWith(pattern.slice(0, -1));
}

export function applyProfile(config: SessionConfig, profile: GovernanceProfile): SessionConfig {
    assertModelAllowed(profile, config.model);
    return {
        ...config,
        model: profile.model ?? config.model,
        mcpServers: profile.mcpServers ?? config.mcpServers,
    };
}
