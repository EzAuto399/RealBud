import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";
import { writeFileAtomic } from "./atomic.js";
const platforms = new Set(["telegram", "discord", "slack"]);
const lifetime = 10 * 60_000;
function file(platform) {
    if (!platforms.has(platform))
        throw new Error("Unknown messaging app");
    return join(DATA_DIR, `pairing-${platform}.json`);
}
const hash = (text) => createHash("sha256").update(text).digest();
/** The local authenticated UI receives the code once; disk stores only its digest. */
export function createPairingCode(platform, now = Date.now()) {
    const code = randomBytes(8).toString("hex").toUpperCase();
    const expiresAt = now + lifetime;
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileAtomic(file(platform), JSON.stringify({ digest: hash(code).toString("hex"), expiresAt }), 0o600);
    return { command: `/pair ${code}`, expiresAt };
}
export function matchesPairingCode(platform, text, now = Date.now()) {
    const match = /^\/pair\s+([a-f0-9]{16})$/i.exec(text.trim());
    if (!match)
        return false;
    try {
        const row = JSON.parse(readFileSync(file(platform), "utf8"));
        if (!Number.isFinite(row.expiresAt) || row.expiresAt <= now || row.expiresAt > now + lifetime || !/^[a-f0-9]{64}$/.test(row.digest))
            return false;
        return timingSafeEqual(hash(match[1].toUpperCase()), Buffer.from(row.digest, "hex"));
    }
    catch {
        return false;
    }
}
export function clearPairingCode(platform) {
    try {
        unlinkSync(file(platform));
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
}
