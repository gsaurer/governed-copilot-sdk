export function getProfile(policy, name) {
    const profile = policy.profiles[name];
    if (!profile)
        throw new Error(`Unknown governance profile '${name}'.`);
    return profile;
}
export function defaultProfileName(policy) {
    if (!policy.profiles[policy.defaultProfile])
        throw new Error(`Unknown default governance profile '${policy.defaultProfile}'.`);
    return policy.defaultProfile;
}
export function assertModelAllowed(profile, model) {
    if (!model)
        return;
    if (profile.deniedModels?.some((pattern) => matchesModel(model, pattern))) {
        throw new Error(`Model '${model}' is denied by profile '${profile.name}'.`);
    }
    if (profile.allowedModels && !profile.allowedModels.some((pattern) => matchesModel(model, pattern))) {
        throw new Error(`Model '${model}' is not allowed by profile '${profile.name}'.`);
    }
}
export function isHigherClassification(policy, candidate, currentProfile) {
    const targetProfile = policy.classifications[candidate];
    return Boolean(targetProfile && currentProfile.upgradeTargets.includes(targetProfile));
}
export function profileForClassification(policy, classification) {
    const profileName = policy.classifications[classification];
    return profileName ? policy.profiles[profileName] : undefined;
}
export function matchesTool(toolName, filters) {
    return filters.some((filter) => filter === toolName || (filter.endsWith("*") && toolName.startsWith(filter.slice(0, -1))));
}
function matchesModel(model, pattern) {
    if (pattern === "github/*")
        return !model.includes("/");
    return pattern === "*" || model === pattern || pattern.endsWith("*") && model.startsWith(pattern.slice(0, -1));
}
export function applyProfile(config, profile) {
    assertModelAllowed(profile, config.model);
    return {
        ...config,
        model: profile.model ?? config.model,
        mcpServers: profile.mcpServers ?? config.mcpServers,
    };
}
