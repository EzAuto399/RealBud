import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { sweepStaleTempFiles } from "./temp-sweep.ts";

const uuid = "8a0c5919-aa23-463e-bb01-bb12296c4f5d";
let root = "";
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

it("removes only our own temp files from before this boot, and nothing else", () => {
  root = mkdtempSync(join(tmpdir(), "realbud-temp-sweep-"));
  const old = new Date(Date.now() - 60_000);
  const write = (path: string, stale = true) => { writeFileSync(join(root, path), "x"); if (stale) utimesSync(join(root, path), old, old); };
  mkdirSync(join(root, "desk-backups")); mkdirSync(join(root, "hermes"));
  write(`desk-backups/desk-9.json.59844.${uuid}.tmp`);
  write(`bots.json.60492.${uuid}.tmp`);
  write(`state.json.${uuid}.tmp`);
  write(`fresh.json.1.${uuid}.tmp`, false);
  write(`hermes/config.json.1.${uuid}.tmp`);
  write("desk.json"); write("notes.tmp"); write(`.hidden.${uuid}.tmp`);
  symlinkSync(join(root, "desk.json"), join(root, `link.json.1.${uuid}.tmp`));
  const removed = sweepStaleTempFiles(root, Date.now() - 1000);
  expect(removed.sort()).toEqual([`bots.json.60492.${uuid}.tmp`, `desk-backups/desk-9.json.59844.${uuid}.tmp`, `state.json.${uuid}.tmp`]);
  expect(readdirSync(root).sort()).toEqual([`.hidden.${uuid}.tmp`, "desk-backups", "desk.json", `fresh.json.1.${uuid}.tmp`, "hermes", `link.json.1.${uuid}.tmp`, "notes.tmp"]);
  expect(readdirSync(join(root, "hermes"))).toHaveLength(1);
});
