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

it.skipIf(process.platform === "win32")("keeps an existing unsafe POSIX root unchanged and refuses approval writes", async () => {
  mkdirSync(DATA_DIR, { mode: 0o755 }); chmodSync(DATA_DIR, 0o755);
  const sentinel = join(DATA_DIR, "fictional-existing-state.json");
  const original = '{"fictional":"preserved"}';
  writeFileSync(sentinel, original, { mode: 0o600 });
  ensureDirs();
  expect(statSync(DATA_DIR).mode & 0o777).toBe(0o755);
  await expect(new BrowserApprovalStore().create(draft(), owner, "pending")).rejects.toThrow("Private state directory needs recovery.");
  expect(existsSync(file)).toBe(false);
  expect(readFileSync(sentinel, "utf8")).toBe(original);
  expect(statSync(DATA_DIR).mode & 0o777).toBe(0o755);
});
