const sensitivityOrder = ["public", "internal", "confidential", "restricted"];
export function getProfile(policy, name) {
    const profile = policy.profiles[name];
    if (!profile)
        throw new Error(`Unknown governance profile '${name}'.`);
    return profile;
}
export function assertModelAllowed(profile, model) {
    if (!model || !profile.model || model === profile.model)
        return;
    throw new Error(`Model '${model}' is not allowed by profile '${profile.name}'.`);
}
export function isHigherSensitivity(candidate, current) {
    return sensitivityOrder.indexOf(candidate) > sensitivityOrder.indexOf(current);
}
export function matchesTool(toolName, filters) {
    return filters.some((filter) => filter === toolName || (filter.endsWith(":*") && toolName.startsWith(filter.slice(0, -1))));
}
export function applyProfile(config, profile) {
    assertModelAllowed(profile, config.model);
    return {
        ...config,
        model: profile.model ?? config.model,
        mcpServers: profile.mcpServers ?? config.mcpServers,
    };
}
