// What a refused provisioning preflight tells the person and the log.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOfficeLink, preflightRefusal } from "./office-link.ts";
import { PrivateStorageError } from "./private-json.ts";
import { setOpLogPath } from "./oplog.ts";

const code = `rb1_${"a".repeat(64)}`;
const SECRET_PATH = "C:\\Users\\fictional-person\\.realbud";
const aclRefusal = (category: string) => Object.assign(
  new Error(`Windows file privacy could not be verified. Use a private directory owned by the trusted installer account. [windows-acl:${category}; exit=3]`),
  { name: "WindowsFilePrivacyError", category, operationIndex: null },
);
const wrapped = (cause: unknown, step: string) => Object.assign(
  new Error("This computer’s service setup needs local storage recovery. Existing settings are kept.", { cause }), { preflightStep: step });

let root = "";
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "realbud-preflight-")); setOpLogPath(join(root, "realbud.log")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("preflightRefusal", () => {
  it("names the store and the Windows reason for an ACL refusal, and logs only step, names and token", () => {
    const { message, log } = preflightRefusal(wrapped(aclRefusal("grant-not-allowed"), "data folder"));
    expect(message).toBe("RealBud's data folder on this computer has Windows permissions RealBud can't use: another account or group on this computer can open it. Your work is kept. "
      + "Contact RealBud support at hello@realbud.app with a support file (Workspace → Settings & help → Save support file) before trying office setup again.");
    expect(log).toEqual({ step: "data folder", errors: "Error<-WindowsFilePrivacyError", acl: "[windows-acl:grant-not-allowed]" });
  });

  it("says Windows could not check when the helper itself failed", () => {
    const { message, log } = preflightRefusal(wrapped(aclRefusal("powershell-not-found"), "profile file"));
    expect(message).toMatch(/^Windows couldn't check the permissions on a file in Bud's private profile on this computer\. Your work is kept\. Contact RealBud support at hello@realbud\.app/);
    expect(log.acl).toBe("[windows-acl:powershell-not-found]");
  });

  it("says Windows could not update when a repair could not be applied", () => {
    const { message } = preflightRefusal(wrapped(aclRefusal("acl-apply-failed"), "data folder"));
    expect(message).toMatch(/^Windows couldn't update the permissions on RealBud's data folder on this computer\. Your work is kept\./);
  });

  it("passes a nested private-storage refusal through and keeps the generic text for anything else", () => {
    const plain = new PrivateStorageError("RealBud's data folder belongs to another account on this Mac, so RealBud will not use it.");
    expect(preflightRefusal(wrapped(new Error(`fictional ${SECRET_PATH}`, { cause: plain }), "vault")).message)
      .toBe("RealBud's data folder belongs to another account on this Mac, so RealBud will not use it. Your work is kept.");
    const other = preflightRefusal(wrapped(Object.assign(new Error(`parse failed at ${SECRET_PATH}`), { name: "Weird name /path" }), "config"));
    expect(other.message).toBe("This computer's saved settings or private service storage need recovery. Your work is kept. Repair the local storage before retrying office setup.");
    expect(other.log).toEqual({ step: "config", errors: "Error<-Error" });
    expect(preflightRefusal(new Error("untagged")).log).toEqual({ step: "unknown", errors: "Error" });
  });
});

describe("office link with a refused preflight", () => {
  it("shows the role-named reason, never contacts the website, and logs the refusal once without a path", async () => {
    const fetcher = vi.fn();
    const app = createOfficeLink({ directory: root, appVersion: "fictional", fetch: fetcher as unknown as typeof fetch,
      report: async () => ({ appVersion: "fictional", workerVersion: null, workerReady: true }),
      provisioning: { apply: vi.fn(), withdraw: vi.fn(async () => false), withdrawn: vi.fn(async () => false),
        reconcile: vi.fn(async () => false), clear: vi.fn(async () => {}),
        preflight: async () => { throw wrapped(aclRefusal("deny-rule-present"), "data folder"); } } });
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(app.link({ code, label: "Fictional desk" })).rejects.toMatchObject({
        status: 503, code: "service_provisioning_local_recovery",
        message: expect.stringMatching(/^RealBud's data folder on this computer has Windows permissions RealBud can't use: a Windows rule blocks access to it\. Your work is kept\./),
      });
    }
    expect(fetcher).not.toHaveBeenCalled();
    const path = join(root, "realbud.log");
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: "storage", step: "data folder", errors: "Error<-WindowsFilePrivacyError", acl: "[windows-acl:deny-rule-present]" });
    expect(readFileSync(path, "utf8")).not.toContain(root);
  });
});
