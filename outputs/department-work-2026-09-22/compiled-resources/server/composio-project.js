// Composio project lifecycle — the Platform *organisation* surface, which is
// authenticated with the org key (x-org-api-key), not a project key.
//
// RealBud gives each office one Composio project. Reading and listing projects is
// how an office's project is identified at all; deleting it with
// ?revoke_on_delete=true is the only call in the product that actually revokes
// the office's upstream OAuth credentials at Google/Microsoft/etc. So delete is
// deliberately fail-closed and never retried: a caller reports its result to an
// operator as "client access is gone".
//
// Deliberate duplication: PROJECT_API_KEY mirrors the private PROJECT_KEY regex
// in server/composio.ts. That module does not export it and must not be edited
// for this one, so the two are kept in step by hand.
export const COMPOSIO_PLATFORM_API = "https://backend.composio.dev/api/v3.1";
const PROJECT_API_KEY = /^ak_[a-zA-Z0-9_-]{6,512}$/;
const PROJECT_ID = /^pr_[a-zA-Z0-9_-]{1,128}$/;
const PROJECT_NAME_MAX = 200;
const REQUEST_TIMEOUT_MS = 60_000;
const ORG_KEY_ENV = "REALBUD_COMPOSIO_ORG_KEY";
class ComposioError extends Error {
    constructor(message) {
        super(message);
        this.name = "ComposioError";
    }
}
const record = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
function reasonText(error) {
    return error instanceof Error && error.message ? error.message : "the request failed";
}
/**
 * Base URL for the Platform API. `REALBUD_COMPOSIO_API_BASE` is a test and
 * self-hosted seam (a fixture server, a local proxy), not a user setting:
 * nothing in the desk UI, the office config or a request body can write it, and
 * a value that is set but unusable fails closed rather than quietly falling back
 * to Composio. It is read per call so a test can point this module at a fixture
 * server after import.
 */
function platformBase() {
    const configured = process.env.REALBUD_COMPOSIO_API_BASE;
    if (configured === undefined)
        return COMPOSIO_PLATFORM_API;
    const raw = configured.trim();
    if (!raw)
        throw new ComposioError("REALBUD_COMPOSIO_API_BASE is set but empty. Unset it to use Composio, or give it the full base URL of the Platform API.");
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        throw new ComposioError("REALBUD_COMPOSIO_API_BASE is not a valid URL.");
    }
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.hash || url.search || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
        throw new ComposioError("REALBUD_COMPOSIO_API_BASE must be an HTTPS base URL without embedded credentials or a query.");
    }
    return raw.replace(/\/+$/, "");
}
function checkedOrgKey(orgKey) {
    if (typeof orgKey !== "string" || !orgKey.trim()) {
        throw new ComposioError(`No Composio organisation key. Set ${ORG_KEY_ENV} to the x-org-api-key value from the Composio dashboard, then try again.`);
    }
    const key = orgKey.trim();
    // A CR/LF or other control character makes fetch reject the header, which
    // would otherwise surface as an unrelated network failure.
    if (!/^[\x21-\x7e]{1,4096}$/.test(key)) {
        throw new ComposioError("The Composio organisation key is not a usable header value; re-copy it from the Composio dashboard.");
    }
    return key;
}
function checkedProjectId(nanoId) {
    const id = typeof nanoId === "string" ? nanoId.trim() : "";
    // The id is interpolated into the request path, so its shape is what keeps a
    // caller-supplied string from reaching any other endpoint. The rejected value
    // is never echoed: a caller that mixed up arguments may have passed a key.
    if (!PROJECT_ID.test(id)) {
        throw new ComposioError("That is not a Composio project id (pr_…). Nothing was sent to Composio, because the id decides which office's project is acted on.");
    }
    return id;
}
function checkedProjectName(name) {
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!trimmed || trimmed.length > PROJECT_NAME_MAX || /[\x00-\x1f\x7f]/.test(trimmed)) {
        throw new ComposioError(`Give the Composio project a name of 1–${PROJECT_NAME_MAX} characters, with no control characters.`);
    }
    return trimmed;
}
/** One Platform call. Every response must be exactly 200: these endpoints
 * document 200 for success, and any other status leaves the outcome
 * unconfirmed — including whether a project was created before the call failed. */
async function platformCall(orgKey, method, path, body) {
    // Resolved outside the try: a misconfigured base URL is a configuration
    // failure and must not be reported to the caller as a network failure.
    const base = platformBase();
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response;
    try {
        response = await fetch(`${base}${path}`, {
            method, redirect: "error", signal,
            headers: { "x-org-api-key": orgKey, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    }
    catch (error) {
        // Nothing here retries. A repeated delete is a second irreversible
        // operation, and a repeated create makes a project an operator then has to
        // hunt down; the caller decides, with the failure in front of it.
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
            throw new ComposioError(`Composio did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds.`);
        }
        throw new ComposioError("Composio could not be reached from this machine.");
    }
    if (response.redirected) {
        await response.body?.cancel().catch(() => { });
        throw new ComposioError("Composio redirected the request; refusing to follow a redirect that would carry the organisation key to another host.");
    }
    if (response.status !== 200) {
        await response.body?.cancel().catch(() => { });
        // Provider error bodies can quote the key that was sent, so only the status
        // is reported — never the body.
        const hint = response.status === 401 || response.status === 403 ? " (check the organisation key and its access)"
            : response.status === 409 ? " (a project with this name may already exist)"
                : response.status === 429 ? " (rate limited; try again later)" : "";
        throw new ComposioError(`Composio returned HTTP ${response.status}${hint}.`);
    }
    try {
        return await response.json();
    }
    catch {
        throw new ComposioError("Composio returned a body that is not JSON.");
    }
}
/** Composio returns this shape from create and get. `apiKey` is optional: a read
 * may not be allowed to see one, but any key that *is* present has to be usable
 * — a malformed one is a broken deployment, not something to pass along. */
function readProject(value, context, requireKey) {
    if (!record(value))
        throw new ComposioError(context);
    const id = typeof value.id === "string" ? value.id.trim() : "";
    const name = typeof value.name === "string" ? value.name.trim() : "";
    if (!PROJECT_ID.test(id) || !name || name.length > PROJECT_NAME_MAX || /[\x00-\x1f\x7f]/.test(name))
        throw new ComposioError(context);
    const raw = value.api_key;
    if (raw === undefined || raw === null) {
        if (requireKey)
            throw new ComposioError("Composio created the project but returned no project API key (ak_…), so the office cannot use it. Regenerate the key in the Composio dashboard.");
        return { id, name };
    }
    // The key value is never echoed, not even when it is rejected.
    if (typeof raw !== "string" || !PROJECT_API_KEY.test(raw)) {
        throw new ComposioError("Composio returned a project API key that is not in the expected ak_… form; do not use it. Regenerate the key in the Composio dashboard.");
    }
    return { id, name, apiKey: raw };
}
export async function createProject(orgKey, name) {
    const key = checkedOrgKey(orgKey);
    const projectName = checkedProjectName(name);
    // Ask for the key up front: the office needs it to use the project at all, and
    // Composio only returns it from this call and from regenerate.
    const body = await platformCall(key, "POST", "/org/owner/project/new", { name: projectName, should_create_api_key: true });
    return readProject(body, "Composio did not return a readable new project. Check the project in the Composio dashboard.", true);
}
export async function regenerateProjectKey(orgKey, nanoId) {
    const key = checkedOrgKey(orgKey);
    const id = checkedProjectId(nanoId);
    const body = await platformCall(key, "POST", `/org/owner/project/${id}/regenerate_api_key`);
    const apiKey = record(body) && record(body.api_key) ? body.api_key.key : undefined;
    if (typeof apiKey !== "string" || !PROJECT_API_KEY.test(apiKey)) {
        // Regenerating already invalidated every earlier key, so losing the
        // replacement leaves the office with no working key at all.
        throw new ComposioError("Composio regenerated the project key but returned no readable replacement (ak_…). Every earlier key is already invalid — regenerate again in the Composio dashboard.");
    }
    return apiKey;
}
export async function getProject(orgKey, nanoId) {
    const key = checkedOrgKey(orgKey);
    const id = checkedProjectId(nanoId);
    return readProject(await platformCall(key, "GET", `/org/owner/project/${id}`), "Composio did not return a readable project for that id. Check the project in the Composio dashboard.", false);
}
export async function listProjects(orgKey) {
    const key = checkedOrgKey(orgKey);
    const body = await platformCall(key, "GET", "/org/owner/project/list");
    const items = Array.isArray(body) ? body : record(body) && Array.isArray(body.items) ? body.items : null;
    if (!items)
        throw new ComposioError("Composio returned a project list RealBud could not read.");
    // A truncated list would hide a project that still holds live credentials;
    // pages are not followed here, so an operator resolves it in the dashboard.
    if (record(body) && body.next_cursor) {
        throw new ComposioError("Composio returned only part of the project list. Resolve it in the Composio dashboard before relying on this list.");
    }
    return items.map((item) => readProject(item, "Composio returned an unreadable entry in the project list.", false));
}
/**
 * Delete an office's Composio project, and by default ask Composio to revoke the
 * upstream OAuth credentials of every connection in it.
 *
 * Fail-closed on purpose. The caller tells an operator that a departing office's
 * client access is gone, so the only successful outcome is HTTP 200 with
 * `status: "success"` and a revocation job id. Anything else — non-200,
 * unreadable or partial body, missing job id, network failure, timeout — throws,
 * and the delete is never retried, because a second attempt is a second
 * irreversible act whose outcome nobody has seen.
 */
export async function deleteProject(orgKey, nanoId, opts) {
    const key = checkedOrgKey(orgKey);
    const id = checkedProjectId(nanoId);
    // DANGEROUS, tests only. `revokeUpstreamCredentials: false` omits the flag
    // entirely, so the project is deleted while the office's Google/Microsoft
    // refresh tokens stay alive at the provider — the opposite of an offboarding,
    // and invisible in the response. It exists so a test can see the two request
    // shapes; no product path may pass it.
    const revoke = opts?.revokeUpstreamCredentials ?? true;
    let body;
    try {
        body = await platformCall(key, "DELETE", `/org/owner/project/${id}${revoke ? "?revoke_on_delete=true" : ""}`);
    }
    catch (error) {
        throw new ComposioError(`The Composio project was NOT confirmed deleted${revoke ? " and its connections were NOT confirmed revoked" : ""}, so client access may still be live: ${reasonText(error)}`);
    }
    if (!record(body) || body.status !== "success") {
        throw new ComposioError("Composio did not confirm the deletion, so client access may still be live. Check the project in the Composio dashboard before telling anyone it is gone.");
    }
    // The job id is required even when the flag was omitted: the return shape
    // promises one, and a caller must never be handed an empty confirmation.
    const revokeJobId = body.revoke_job_id;
    if (typeof revokeJobId !== "string" || !revokeJobId.trim()) {
        throw new ComposioError("Composio accepted the deletion but returned no credential-revocation job id, so revocation cannot be confirmed. Check the project's connections in the Composio dashboard.");
    }
    return { revokeJobId };
}
