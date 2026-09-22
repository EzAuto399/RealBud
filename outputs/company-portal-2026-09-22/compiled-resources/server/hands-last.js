// Last worker ping or Recheck. Desk and You read the same file so the
// GUI and the worker stay on one clock.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
export function handsLastPath(dir) {
    return join(dir, "hands-last.json");
}
export function readHandsLast(dir) {
    try {
        const raw = JSON.parse(readFileSync(handsLastPath(dir), "utf8"));
        if (!raw || typeof raw !== "object")
            return null;
        const rec = raw;
        if (typeof rec.at !== "number" || typeof rec.ok !== "boolean" || typeof rec.detail !== "string")
            return null;
        if (rec.kind !== "ping" && rec.kind !== "recheck")
            return null;
        return {
            at: rec.at,
            ok: rec.ok,
            detail: rec.detail,
            kind: rec.kind,
            ...(typeof rec.workerFingerprint === "string" ? { workerFingerprint: rec.workerFingerprint } : {}),
        };
    }
    catch {
        return null;
    }
}
export function writeHandsLast(dir, record) {
    writeFileAtomic(handsLastPath(dir), JSON.stringify(record));
}
export function handsLastExists(dir) {
    return existsSync(handsLastPath(dir));
}
/** Last Test-hands ping only. Recheck overwrites hands-last.json and must not
 * clear a successful ping used for `ready`. */
export function handsPingPath(dir) {
    return join(dir, "hands-ping.json");
}
export function readHandsPing(dir) {
    try {
        const raw = JSON.parse(readFileSync(handsPingPath(dir), "utf8"));
        if (!raw || typeof raw !== "object")
            return null;
        const rec = raw;
        if (typeof rec.at !== "number" || typeof rec.ok !== "boolean" || typeof rec.detail !== "string")
            return null;
        if (rec.kind !== "ping")
            return null;
        return {
            at: rec.at,
            ok: rec.ok,
            detail: rec.detail,
            kind: "ping",
            ...(typeof rec.workerFingerprint === "string" ? { workerFingerprint: rec.workerFingerprint } : {}),
        };
    }
    catch {
        return null;
    }
}
export function writeHandsPing(dir, record) {
    writeFileAtomic(handsPingPath(dir), JSON.stringify({ ...record, kind: "ping" }));
}
