import { createHash } from "node:crypto";
import { tokensEqual } from "./session-auth.js";
/** A private per-process capability authorizes shutdown. The public instance
 * identity and a remembered PID grant no authority. App session auth also applies. */
export function serviceControl(token, instanceId, pid = process.pid) {
    const secret = token && /^[a-f0-9]{64}$/.test(token) ? token : null;
    const id = secret ? createHash("sha256").update(secret).digest("hex") : null;
    return {
        id,
        accepts(req, body) {
            const candidate = req.headers["x-realbud-service-control"];
            if (!secret || req.headers.origin || typeof candidate !== "string" || !tokensEqual(candidate, secret))
                return false;
            if (!body || typeof body !== "object" || Array.isArray(body))
                return false;
            const expected = body;
            return expected.pid === pid && expected.instanceId === instanceId && expected.controlId === id;
        },
    };
}
