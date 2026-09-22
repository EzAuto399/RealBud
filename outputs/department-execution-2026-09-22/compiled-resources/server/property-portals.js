/** Exact saved bindings only; never infer a portal from a notification preference. */
export function propertyPortalView(liveIds, bindings, recipes) {
    const recipesByVersion = new Map(recipes.map(recipe => [`${recipe.id}:${recipe.version}`, recipe]));
    const rows = new Map();
    for (const binding of bindings) {
        if (!liveIds.has(binding.propertyId))
            continue;
        let row = rows.get(binding.propertyId);
        if (!row) {
            row = { propertyId: binding.propertyId, origins: [], unresolved: false };
            rows.set(binding.propertyId, row);
        }
        const recipe = recipesByVersion.get(`${binding.recipeId}:${binding.recipeVersion}`);
        try {
            if (!recipe?.published)
                throw new Error("unavailable recipe");
            const url = new URL(recipe.origin);
            if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
                throw new Error("invalid origin");
            if (!row.origins.includes(url.origin))
                row.origins.push(url.origin);
        }
        catch {
            row.unresolved = true;
        }
    }
    return [...rows.values()].map(row => ({ ...row, origins: row.origins.sort() }));
}
