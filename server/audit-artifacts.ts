// Encrypted audit artifacts. Persist + fsync first, then reference from Desk.
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { writeFileAtomic } from "./atomic.ts";
import { decryptBytes, encryptBytes, isEncryptedEnvelope } from "./desk-crypto.ts";
import { loadDeskKey } from "./desk-key.ts";
import { DATA_DIR } from "./config.ts";

export interface ArtifactMeta {
  id: string;
  workItemId: string;
  step: string;
  createdAt: number;
  mime: string;
  bytes: number;
}

export function artifactsDir(root?: string): string {
  return join(root ?? DATA_DIR, "artifacts");
}

export function persistArtifact(opts: {
  dir?: string;
  workItemId: string;
  step: string;
  mime?: string;
  body: Buffer;
  now?: number;
}): ArtifactMeta {
  const dir = artifactsDir(opts.dir);
  mkdirSync(dir, { recursive: true });
  const id = `art-${randomUUID()}`;
  const key = loadDeskKey({ dir: opts.dir ?? DATA_DIR }).key;
  const envelope = encryptBytes(key, opts.body);
  const path = join(dir, `${id}.bin`);
  writeFileAtomic(path, JSON.stringify(envelope));
  const meta: ArtifactMeta = {
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

export function readArtifact(id: string, dir?: string): { meta: ArtifactMeta; body: Buffer } {
  const root = artifactsDir(dir);
  const meta = JSON.parse(readFileSync(join(root, `${id}.meta.json`), "utf8")) as ArtifactMeta;
  const raw = JSON.parse(readFileSync(join(root, `${id}.bin`), "utf8"));
  if (!isEncryptedEnvelope(raw)) throw new Error("artifact is not an encrypted envelope");
  const key = loadDeskKey({ dir: dir ?? DATA_DIR }).key;
  return { meta, body: decryptBytes(key, raw) };
}

export function scanOrphans(referenced: Set<string>, dir?: string): string[] {
  const root = artifactsDir(dir);
  if (!existsSync(root)) return [];
  const orphans: string[] = [];
  for (const name of readdirSync(root)) {
    if (!name.endsWith(".meta.json")) continue;
    const id = name.slice(0, -".meta.json".length);
    if (!referenced.has(id)) orphans.push(id);
  }
  return orphans;
}
