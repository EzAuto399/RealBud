// The readiness checks read `config.yaml` as Hermes' own parser (PyYAML) will.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyPropertyPack, policyDocument, propertyProfileDir, strictBool, workerLimitsReady } from "./hermes-pack.ts";
import { privateFixtureRoot, WINDOWS_PROFILE_TEST_OPTIONS } from "./testing/private-profile-fixture.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
// The profile home must be private on Windows; overwriting config.yaml keeps its ACL.
const home = () => { const dir = privateFixtureRoot(join(tmpdir(), "rb-yaml-")); dirs.push(dir); return dir; };

describe("policy document", WINDOWS_PROFILE_TEST_OPTIONS, () => {
  it("keeps a bare y/n a string as PyYAML does, and counts only canonical true/false as a security switch", () => {
    const doc = policyDocument("a: n\nb: N\nc: y\nd: yes\ne: false\nf: False\ng: true\n");
    expect(doc.toJS()).toEqual({ a: "n", b: "N", c: "y", d: true, e: false, f: false, g: true });
    expect(strictBool(doc, ["e"], false)).toBe(true);
    expect(strictBool(doc, ["g"], true)).toBe(true);
    for (const key of ["a", "b", "d", "f"]) expect(strictBool(doc, [key], false)).toBe(false);
    expect(strictBool(doc, ["f"], false)).toBe(false);
    expect(strictBool(doc, ["missing"], false)).toBe(false);
  });

  it("refuses explicitly tagged values (PyYAML raises on `!!bool n`; the pack never writes tags)", () => {
    for (const raw of ["a: !!bool n\n", "a: !!bool y\n", "a: !!bool false\n", "a: !!str n\n", "a: !!int 1\n", "a: !!pairs [x]\n", "a: !!omap [x]\n", "a: !!set {x}\n", "a: !!map {b: 1}\n", "a: !!seq [1]\n"]) expect(() => policyDocument(raw)).toThrow(/unreadable/);
    const root = home();
    applyPropertyPack(root);
    const config = join(propertyProfileDir(root), "config.yaml");
    const ready = readFileSync(config, "utf8");
    for (const probe of ["round2_probe: !!bool n\n", "round3_probe: !!pairs [x]\n", "round3_probe: !!omap [x]\n"]) {
      writeFileSync(config, `${ready}${probe}`);
      expect(workerLimitsReady(root)).toBe(false);
    }
  });

  it("refuses collection keys, which PyYAML cannot load, instead of reading past them", () => {
    expect(() => policyDocument("? [a, b]\n: 1\nx: 2\n")).toThrow(/unreadable/);
    expect(() => policyDocument("? {a: 1}\n: 1\n")).toThrow(/unreadable/);
    expect(() => policyDocument("a: 1\na: 2\n")).toThrow(/unreadable/);
  });

  it("fails the worker limits when a vault switch is spelled n", () => {
    const root = home();
    applyPropertyPack(root);
    expect(workerLimitsReady(root)).toBe(true);
    const config = join(propertyProfileDir(root), "config.yaml");
    const raw = readFileSync(config, "utf8");
    expect(raw).toMatch(/onepassword:\n\s+enabled: false/);
    writeFileSync(config, raw.replace(/onepassword:\n(\s+)enabled: false/, "onepassword:\n$1enabled: n"));
    expect(workerLimitsReady(root)).toBe(false);
  });
});

// PyYAML on the pinned runtime: REALBUD_HERMES_TEST_RUNTIME=<hermes home>/runtimes/<commit>
const runtime = process.env.REALBUD_HERMES_TEST_RUNTIME?.trim();
const python = runtime ? join(runtime, "hermes-agent", "venv", "bin", "python") : "";
describe.runIf(python && existsSync(python))("matches the pinned runtime's PyYAML", () => {
  it("reads the same booleans and strings", () => {
    const sample = "a: n\nb: N\nc: y\nd: yes\ne: false\nf: False\ng: true\nh: on\ni: Off\n";
    const theirs = JSON.parse(execFileSync(python, ["-I", "-c", "import json, sys, yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))"], { input: sample, encoding: "utf8" }));
    expect(policyDocument(sample).toJS()).toEqual(theirs);
    expect(theirs).toEqual({ a: "n", b: "N", c: "y", d: true, e: false, f: false, g: true, h: true, i: false });
    const load = (text: string) => execFileSync(python, ["-I", "-c", "import sys, yaml\ntry:\n  yaml.safe_load(sys.stdin.read()); print('loaded')\nexcept Exception as e:\n  print('refused')"], { input: text, encoding: "utf8" }).trim();
    expect(load("? [a, b]\n: 1\n")).toBe("refused");
    for (const tagged of ["a: !!bool n\n", "a: !!bool y\n", "a: !!bool N\n", "a: !!pairs [x]\n", "a: !!omap [x]\n"]) { expect(load(tagged)).toBe("refused"); expect(() => policyDocument(tagged)).toThrow(/unreadable/); }
  });
});
