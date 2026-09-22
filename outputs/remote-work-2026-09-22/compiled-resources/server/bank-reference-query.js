const fail = () => { throw Object.assign(new Error('The bank history page is invalid. Refresh the history and try again.'), { status: 400 }); };
export function bankReferenceQuery(params, history = false) {
    const seen = new Set();
    for (const [key] of params) {
        if (!history || !['cursor', 'limit'].includes(key) || seen.has(key))
            fail();
        seen.add(key);
    }
    const rawLimit = params.get('limit'), cursor = params.get('cursor');
    if (rawLimit !== null && (!/^[1-9][0-9]{0,2}$/.test(rawLimit) || Number(rawLimit) > 100))
        fail();
    if (cursor !== null && (!cursor || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)))
        fail();
    return { ...(rawLimit === null ? {} : { limit: Number(rawLimit) }), ...(cursor === null ? {} : { cursor }) };
}
