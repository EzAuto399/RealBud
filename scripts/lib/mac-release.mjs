import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";

export function requireAccepted(result) {
  if (!result || typeof result.id !== "string" || !/^[a-f0-9-]{36}$/i.test(result.id) || result.status !== "Accepted") {
    throw new Error(`Apple has not accepted this submission (${result?.status ?? "unknown"}). No release files were promoted.`);
  }
  return result.id;
}

export function releaseNames(version) {
  if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(version)) throw new Error("Invalid release version");
  return { zip: `RealBud-${version}-arm64.zip`, dmg: `RealBud-${version}.dmg`, metadata: "latest-mac.yml" };
}

export async function fileInfo(file) {
  const hash = createHash("sha512");
  let size = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); size += chunk.length; }
  return { size, sha512: hash.digest("base64") };
}

export function refreshMetadata(metadata, version, info) {
  const names = releaseNames(version);
  if (metadata?.version !== version || !Array.isArray(metadata.files) || metadata.files.length !== 2 ||
      new Set(metadata.files.map(file => file.url)).size !== 2 ||
      metadata.files.some(file => ![names.zip, names.dmg].includes(file.url)) || metadata.path !== names.zip) {
    throw new Error("Update metadata does not describe this exact Mac release");
  }
  for (const name of [names.zip, names.dmg]) {
    if (!Number.isSafeInteger(info[name]?.size) || info[name].size <= 0 || !/^[A-Za-z0-9+/]{86}==$/.test(info[name].sha512)) {
      throw new Error(`Missing verified file information for ${name}`);
    }
  }
  return { ...metadata, files: metadata.files.map(file => ({ ...file, ...info[file.url] })), sha512: info[names.zip].sha512 };
}

// Keep the previous set until every replacement succeeds. This is a local
// release operation; callers must hold the release lock and publish only
// after it returns. A crash leaves the previous set in the retained stage.
export function promoteArtifacts(source, destination, names, move = renameSync) {
  if (names.some(name => path.basename(name) !== name) || new Set(names).size !== names.length) throw new Error("Invalid artifact names");
  for (const name of names) if (!existsSync(path.join(source, name))) throw new Error(`Missing staged artifact: ${name}`);
  const backup = path.join(source, "previous-release");
  mkdirSync(backup);
  const replaced = [], installed = [];
  try {
    for (const name of names) {
      const current = path.join(destination, name);
      if (existsSync(current)) { move(current, path.join(backup, name)); replaced.push(name); }
      move(path.join(source, name), current);
      installed.push(name);
    }
  } catch (error) {
    try {
      for (const name of installed.reverse()) move(path.join(destination, name), path.join(source, name));
      for (const name of replaced.reverse()) move(path.join(backup, name), path.join(destination, name));
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `Promotion and rollback failed; recover previous files from ${backup}`);
    }
    throw error;
  }
}
