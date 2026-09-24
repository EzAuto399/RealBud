const fail = (): never => { throw Object.assign(new Error('The bill list options are invalid. Refresh this view and try again.'), { status: 400 }); };

export function billQuery(params: URLSearchParams, allowed: readonly string[]): void {
  const seen = new Set<string>();
  for (const [key] of params) {
    if (!allowed.includes(key) || seen.has(key)) fail();
    seen.add(key);
  }
}
export function billQueryText(params: URLSearchParams, key: string, max: number): string | undefined {
  const value = params.get(key);
  if (value === null) return undefined;
  if (!value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail();
  return value.trim();
}
export function billPageQuery(params: URLSearchParams) {
  const raw = params.get('limit');
  if (raw !== null && (!/^[1-9][0-9]{0,2}$/.test(raw) || Number(raw) > 100)) fail();
  const cursor = billQueryText(params, 'cursor', 8192);
  if (cursor && !/^[A-Za-z0-9_-]+$/.test(cursor)) fail();
  return { limit: raw === null ? 20 : Number(raw), ...(cursor ? { cursor } : {}),
    ...(params.has('propertyId') ? { propertyId: billQueryText(params, 'propertyId', 200)! } : {}) };
}
