// Encrypted audit artifacts. Persist + fsync first, then reference from Desk.
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "./atomic.js";
import { decryptBytes, encryptBytes, isEncryptedEnvelope } from "./desk-crypto.js";
import { loadDeskKey } from "./desk-key.js";
import { DATA_DIR } from "./config.js";
export function artifactsDir(root) {
    return join(root ?? DATA_DIR, "artifacts");
}
export function persistArtifact(opts) {
    const dir = artifactsDir(opts.dir);
    mkdirSync(dir, { recursive: true });
    const id = `art-${randomUUID()}`;
    const key = loadDeskKey({ dir: opts.dir ?? DATA_DIR }).key;
    const envelope = encryptBytes(key, opts.body);
    const path = join(dir, `${id}.bin`);
    writeFileAtomic(path, JSON.stringify(envelope));
    const meta = {
        id,
        workItemId: opts.workItemId,
        step: opts.step,
        createdAt: opts.now ?? Date.now(),
        mime: opts.mime ?? "application/json",
        bytes: opts.body.length,
    };
    writeFileAtomic(join(dir, `${id}.meta.json`), JSON.stringify(meta));
    return meta;
}
export function readArtifact(id, dir) {
    const root = artifactsDir(dir);
    const meta = JSON.parse(readFileSync(join(root, `${id}.meta.json`), "utf8"));
    const raw = JSON.parse(readFileSync(join(root, `${id}.bin`), "utf8"));
    if (!isEncryptedEnvelope(raw))
        throw new Error("artifact is not an encrypted envelope");
    const key = loadDeskKey({ dir: dir ?? DATA_DIR }).key;
    return { meta, body: decryptBytes(key, raw) };
}
export function scanOrphans(referenced, dir) {
    const root = artifactsDir(dir);
    if (!existsSync(root))
        return [];
    const orphans = [];
    for (const name of readdirSync(root)) {
        if (!name.endsWith(".meta.json"))
            continue;
        const id = name.slice(0, -".meta.json".length);
        if (!referenced.has(id))
            orphans.push(id);
    }
    return orphans;
}
