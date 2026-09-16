import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileInfo, promoteArtifacts, refreshMetadata, releaseNames, requireAccepted } from "./lib/mac-release.mjs";

test("only an explicit Apple Accepted result passes", () => {
  const id = "12345678-1234-1234-1234-123456789abc";
  assert.equal(requireAccepted({ id, status: "Accepted" }), id);
  for (const status of ["Invalid", "In Progress", "Rejected", "Not Accepted", undefined]) assert.throws(() => requireAccepted({ id, status }));
  assert.throws(() => requireAccepted({ status: "Accepted" }));
});

test("metadata identifies both exact archives and uses their final hashes", () => {
  const { zip, dmg } = releaseNames("0.1.17");
  const metadata = { version: "0.1.17", files: [{ url: zip }, { url: dmg }], path: zip, sha512: "stale" };
  const info = { [zip]: { size: 100, sha512: `${"a".repeat(86)}==` }, [dmg]: { size: 200, sha512: `${"b".repeat(86)}==` } };
  const refreshed = refreshMetadata(metadata, "0.1.17", info);
  assert.equal(refreshed.sha512, info[zip].sha512);
  assert.deepEqual(refreshed.files[1], { url: dmg, ...info[dmg] });
  assert.equal(metadata.sha512, "stale");
  for (const invalid of [{ ...metadata, version: "0.1.16" }, { ...metadata, path: "../other.zip" }, { ...metadata, files: [{ url: zip }, { url: zip }] }]) assert.throws(() => refreshMetadata(invalid, "0.1.17", info));
  assert.throws(() => refreshMetadata(metadata, "0.1.17", { ...info, [dmg]: { size: 0, sha512: "bad" } }));
  assert.throws(() => releaseNames("../wrong"));
});

test("file hashes change with the final stapled bytes", async t => {
  const dir = mkdtempSync(path.join(tmpdir(), "realbud-hash-test-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "app.dmg");
  writeFileSync(file, "before"); const before = await fileInfo(file);
  writeFileSync(file, "after-ticket"); const after = await fileInfo(file);
  assert.notEqual(after.sha512, before.sha512); assert.equal(after.size, 12);
});

for (const shouldFail of [false, true]) test(`artifact promotion ${shouldFail ? "restores every old file after partial failure" : "replaces the complete verified set"}`, t => {
  const dir = mkdtempSync(path.join(tmpdir(), "realbud-promotion-test-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "source"), destination = path.join(dir, "release"); mkdirSync(source); mkdirSync(destination);
  for (const name of ["app.zip", "app.dmg", "latest-mac.yml"]) { writeFileSync(path.join(source, name), `new:${name}`); writeFileSync(path.join(destination, name), `old:${name}`); }
  let failed = false;
  const move = (from, to) => { if (shouldFail && !failed && from === path.join(source, "app.dmg")) { failed = true; throw new Error("disk failure"); } renameSync(from, to); };
  const promote = () => promoteArtifacts(source, destination, ["app.zip", "app.dmg", "latest-mac.yml"], move);
  if (shouldFail) assert.throws(promote, /disk failure/); else promote();
  for (const name of ["app.zip", "app.dmg", "latest-mac.yml"]) assert.equal(readFileSync(path.join(destination, name), "utf8"), `${shouldFail ? "old" : "new"}:${name}`);
});

test("missing staged artifacts cannot replace any existing release file", t => {
  const dir = mkdtempSync(path.join(tmpdir(), "realbud-missing-test-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "source"), destination = path.join(dir, "release"); mkdirSync(source); mkdirSync(destination);
  writeFileSync(path.join(source, "app.zip"), "new"); writeFileSync(path.join(destination, "app.zip"), "old");
  assert.throws(() => promoteArtifacts(source, destination, ["app.zip", "missing"]), /Missing staged/);
  assert.equal(readFileSync(path.join(destination, "app.zip"), "utf8"), "old");
});
