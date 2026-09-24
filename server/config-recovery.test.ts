import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const dir = `${process.env.TEMP || process.env.TMPDIR || process.cwd()}/realbud-config-recovery-${process.pid}-${Date.now().toString(36)}`;
  process.env.REALBUD_DATA_DIR = dir;
  return { dir, failure: "" };
});
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
    if (state.failure && String(args[0]) === join(state.dir, "config.json")) {
      throw Object.assign(new Error("fictional private credential in read error"), { code: state.failure });
    }
    return actual.readFileSync(...args);
  } };
});
const { loadConfig, saveConfig, ConfigRecoveryError } = await import("./config.ts");
const file = join(state.dir, "config.json");
const save = () => saveConfig({ profile: { name: "fictional QA" } });
const assertRecovery = (action: () => unknown) => {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(ConfigRecoveryError);
  expect(caught).toMatchObject({ status: 503, code: "config_recovery_required" });
  expect(String(caught)).not.toContain("fictional private credential");
};

beforeEach(() => {
  state.failure = "";
  rmSync(state.dir, { recursive: true, force: true });
  mkdirSync(state.dir, { recursive: true, mode: 0o700 });
});
afterAll(() => rmSync(state.dir, { recursive: true, force: true }));

it("permits the first save only when the file is absent", () => {
  expect(loadConfig().profile).toBeUndefined();
  expect(existsSync(file)).toBe(false);
  save();
  expect(loadConfig().profile).toEqual({ name: "fictional QA" });
});

it.each(["{interrupted", "null", "[]", '"settings"', "42", '{"profile":[]}', '{"composio":null}', '{"instances":"wrong"}'])(
  "preserves invalid settings on read and attempted ordinary save: %s", raw => {
    writeFileSync(file, raw, { mode: 0o600 });
    assertRecovery(loadConfig); assertRecovery(save);
    expect(readFileSync(file, "utf8")).toBe(raw);
  },
);

it.each(["EACCES", "EIO", "EISDIR", "ENOTDIR"])("refuses %s without overwriting or exposing its details", failure => {
  const raw = JSON.stringify({ composio: { key: "fictional-existing-key" }, profile: { name: "Saved person" } });
  writeFileSync(file, raw, { mode: 0o600 });
  state.failure = failure;
  assertRecovery(loadConfig); assertRecovery(save);
  state.failure = "";
  expect(readFileSync(file, "utf8")).toBe(raw);
  expect(loadConfig().profile?.name).toBe("Saved person");
});

it("accepts a deliberate repair and preserves credentials, unrelated sections and future metadata", () => {
  writeFileSync(file, "{interrupted", { mode: 0o600 });
  assertRecovery(save);
  const repaired = { composio: { key: "fictional-existing-key", selectedAccounts: { gmail: "fictional-account" } },
    profile: { name: "Saved person", email: "fictional@example.test" },
    instances: { fixture: { driver: "not-a-real-driver" } }, futureMetadata: { value: "preserved" } };
  writeFileSync(file, JSON.stringify(repaired), { mode: 0o600 });
  save();
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ...repaired, profile: { ...repaired.profile, name: "fictional QA" } });
});
