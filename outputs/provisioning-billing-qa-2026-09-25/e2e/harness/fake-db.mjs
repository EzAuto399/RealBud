// Stand-in for website/lib/db.ts: only rpc(), backed by the harness's real SQL.
export function getSupabaseAdmin() { return { rpc: (name, args) => globalThis.__rbDb.rpc(name, args) }; }
export function supabaseConfigured() { return true; }
