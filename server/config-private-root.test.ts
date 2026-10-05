import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { privateTempRoot, removeFixture, windowsAdmissionTimeout } from "./testing/private-fixture.ts";

const root = privateTempRoot(join(tmpdir(), "realbud-config-private-root-"));
const priorDataDir = process.env.REALBUD_DATA_DIR;
process.env.REALBUD_DATA_DIR = join(root, "fresh-office");
vi.resetModules();
const { DATA_DIR, EVENTS_DIR, NATIVE_DIR, ensureDirs } = await import("./config.ts");
const { BrowserApprovalStore, browserApprovalDraft } = await import("./browser-authority.ts");
const file = join(DATA_DIR, "browser-approvals.json");
const draft = () => browserApprovalDraft("pay", {
  url: "https://portal.fictional-strata.example/invoice",
  text: 'Pay invoice\nPayee: Fictional Plumbing Pty Ltd\nAmount: AUD 480.00\nReference: INV-FICTIONAL-ROOT\n@e1 button "Pay now"',
}, "@e1", 'button "Pay now"');
const owner = { threadId: "thread-fictional-root", runId: "run-fictional-root", grantId: "grant-fictional-root" };

beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
afterAll(async () => {
  if (priorDataDir === undefined) delete process.env.REALBUD_DATA_DIR;
  else process.env.REALBUD_DATA_DIR = priorDataDir;
  await removeFixture(root);
});

it("fresh ensureDirs permits a real persisted payment approval without fixture pre-creation", windowsAdmissionTimeout(25), async () => {
  expect(existsSync(DATA_DIR)).toBe(false);
  const previousMask = process.umask(0o022);
  try { ensureDirs(); } finally { process.umask(previousMask); }
  if (process.platform !== "win32") {
    for (const dir of [DATA_DIR, EVENTS_DIR, NATIVE_DIR]) expect(statSync(dir).mode & 0o777).toBe(0o700);
  }
  const saved = await new BrowserApprovalStore().create(draft(), owner, "pending");
  expect(saved).toMatchObject({ decision: "pending", outcome: "not-dispatched", ...owner });
  // A fresh store instance must read the actual bytes, not an in-memory row.
  expect(await new BrowserApprovalStore().list()).toEqual([saved]);
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
});

it.skipIf(process.platform === "win32")("tightens an existing owned, too-open POSIX root at launch and keeps its files", async () => {
  mkdirSync(DATA_DIR, { mode: 0o755 }); chmodSync(DATA_DIR, 0o755);
  const sentinel = join(DATA_DIR, "fictional-existing-state.json");
  const original = '{"fictional":"preserved"}';
  writeFileSync(sentinel, original, { mode: 0o600 });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    ensureDirs();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[storage\] RealBud's data folder was open/));
    expect(String(warn.mock.calls[0][0])).not.toContain(root);
  } finally { warn.mockRestore(); }
  expect(statSync(DATA_DIR).mode & 0o777).toBe(0o700);
  await new BrowserApprovalStore().create(draft(), owner, "pending");
  expect(existsSync(file)).toBe(true);
  expect(readFileSync(sentinel, "utf8")).toBe(original);
});

it.skipIf(process.platform === "win32")("reports a foreign-owned root at launch in plain words and still refuses writes", async () => {
  ensureDirs();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const uid = vi.spyOn(process, "getuid").mockReturnValue((process.getuid?.() ?? 0) + 1);
  try {
    ensureDirs();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("RealBud's data folder belongs to another account on this Mac"));
    await expect(new BrowserApprovalStore().create(draft(), owner, "pending")).rejects.toThrow("RealBud's data folder belongs to another account on this Mac");
  } finally { uid.mockRestore(); error.mockRestore(); }
  expect(existsSync(file)).toBe(false);
});
