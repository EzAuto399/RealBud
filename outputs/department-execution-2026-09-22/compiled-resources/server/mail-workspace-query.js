const invalid = () => { throw Object.assign(new Error('This saved-mail page is invalid. Refresh the view and try again.'), { status: 400 }); };
/** Admit query fields before reading or mutating the private mail workspace. */
export function mailWorkspaceQuery(params, page = 'none') {
    const allowed = page === 'tasks' ? ['group', 'q', 'limit', 'cursor'] : page === 'scans' ? ['limit', 'cursor'] : [];
    const seen = new Set();
    for (const [key] of params) {
        if (!allowed.includes(key) || seen.has(key))
            invalid();
        seen.add(key);
    }
    const limit = params.get('limit'), cursor = params.get('cursor'), group = params.get('group'), q = params.get('q');
    if (limit !== null && (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > 100))
        invalid();
    if (cursor !== null && (!cursor || cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)))
        invalid();
    if (group !== null && !['open', 'waiting', 'reference', 'snoozed', 'done', 'all'].includes(group))
        invalid();
    if (q !== null && (q.length > 200 || /[\x00-\x1f\x7f]/.test(q)))
        invalid();
    return { ...(limit === null ? {} : { limit: Number(limit) }), ...(cursor === null ? {} : { cursor }),
        ...(group === null ? {} : { group: group }), ...(q === null ? {} : { q }) };
}
