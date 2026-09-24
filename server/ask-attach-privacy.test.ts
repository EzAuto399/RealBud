import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { saveAskAttachment } from "./ask-attach.ts";
import { windowsFilePrivacySync } from "./windows-file-privacy.ts";

// Inject only the admission boundary. File creation, contents and cleanup stay
// real; native Windows ACL behavior is covered in ask-attach.test.ts.
vi.mock("./windows-file-privacy.ts", () => ({ windowsFilePrivacySync: vi.fn() }));
const roots: string[] = [];
const input = { name: "statement.csv", contentBase64: Buffer.from("fictional selected bytes").toString("base64") };
const fresh = () => { const root = realpathSync(mkdtempSync(join(tmpdir(), "realbud-attach-admission-"))); roots.push(root); return root; };
const existing = () => {
  const root = fresh(), vault = join(root, "vault"), uploads = join(vault, "ask-uploads");
  mkdirSync(vault, { mode: 0o700 }); mkdirSync(uploads, { mode: 0o700 });
  return { root, vault, uploads };
};
afterEach(() => {
  vi.mocked(windowsFilePrivacySync).mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("protects each new directory while empty, then protects the new file before selected bytes", () => {
  const root = join(fresh(), "new-desktop");
  vi.mocked(windowsFilePrivacySync).mockImplementation((path, kind, restrict) => {
    expect(restrict).toBe(true);
    if (kind === "directory") expect(readdirSync(path)).toEqual([]);
    else expect(readFileSync(path)).toEqual(Buffer.alloc(0));
  });
  const saved = saveAskAttachment(root, input);
  expect(windowsFilePrivacySync).toHaveBeenNthCalledWith(1, root, "directory", true);
  expect(windowsFilePrivacySync).toHaveBeenNthCalledWith(2, join(root, "vault"), "directory", true);
  expect(windowsFilePrivacySync).toHaveBeenNthCalledWith(3, join(root, "vault", "ask-uploads"), "directory", true);
  expect(windowsFilePrivacySync).toHaveBeenNthCalledWith(4, saved.path, "file", true);
  expect(readFileSync(saved.path).toString("base64")).toBe(input.contentBase64);
});

it("verifies existing directories without changing them or an earlier selected copy", () => {
  const { root, vault, uploads } = existing(), earlier = join(uploads, "earlier.csv");
  writeFileSync(earlier, "preserved earlier bytes", { mode: 0o600 });
  const identities = [root, vault, uploads].map(path => lstatSync(path).ino);
  const saved = saveAskAttachment(root, input);
  expect(vi.mocked(windowsFilePrivacySync).mock.calls).toEqual([
    [root, "directory", false], [vault, "directory", false], [uploads, "directory", false],
    [saved.path, "file", true],
  ]);
  expect([root, vault, uploads].map(path => lstatSync(path).ino)).toEqual(identities);
  expect(readFileSync(earlier, "utf8")).toBe("preserved earlier bytes");
});

it.each(["root", "vault", "ask-uploads"])("stops at an unverified existing %s without creating a descendant or repairing the folder", segment => {
  const root = fresh(), vault = join(root, "vault"), uploads = join(vault, "ask-uploads");
  if (segment !== "root") mkdirSync(vault, { mode: 0o700 });
  if (segment === "ask-uploads") mkdirSync(uploads, { mode: 0o700 });
  const rejected = segment === "root" ? root : segment === "vault" ? vault : uploads;
  const preserved = join(rejected, "preserved.txt");
  writeFileSync(preserved, "preserve this", { mode: 0o600 });
  vi.mocked(windowsFilePrivacySync).mockImplementation((path, _kind, restrict) => {
    expect(restrict).toBe(false);
    if (path === rejected) throw new Error("fictional private path must not reach the caller");
  });
  expect(() => saveAskAttachment(root, input)).toThrow(/private attachment folder/);
  expect(readdirSync(rejected)).toEqual(["preserved.txt"]);
  expect(readFileSync(preserved, "utf8")).toBe("preserve this");
  expect(vi.mocked(windowsFilePrivacySync).mock.calls.at(-1)).toEqual([rejected, "directory", false]);
});

it.each(["root", "vault", "ask-uploads"])("removes only the empty new %s when its descriptor is refused, so a retry can create it privately", segment => {
  const outer = fresh(), root = segment === "root" ? join(outer, "new-desktop") : outer;
  const rejected = segment === "root" ? root : segment === "vault" ? join(root, "vault") : join(root, "vault", "ask-uploads");
  if (segment === "ask-uploads") mkdirSync(join(root, "vault"), { mode: 0o700 });
  vi.mocked(windowsFilePrivacySync).mockImplementation((path, _kind, restrict) => {
    if (path === rejected) {
      expect(restrict).toBe(true); expect(readdirSync(path)).toEqual([]);
      throw new Error("fictional Windows ACL failure");
    }
  });
  expect(() => saveAskAttachment(root, input)).toThrow(/private attachment folder/);
  expect(existsSync(rejected)).toBe(false);
  vi.mocked(windowsFilePrivacySync).mockReset();
  const saved = saveAskAttachment(root, input);
  expect(windowsFilePrivacySync).toHaveBeenCalledWith(rejected, "directory", true);
  expect(readFileSync(saved.path).toString("base64")).toBe(input.contentBase64);
});

it("closes and removes only its new empty copy when file privacy is refused", () => {
  const { root, uploads } = existing(), earlier = join(uploads, "earlier.csv");
  writeFileSync(earlier, "earlier selected bytes", { mode: 0o600 });
  let rejected = "";
  vi.mocked(windowsFilePrivacySync).mockImplementation((path, kind, restrict) => {
    if (kind === "file") {
      rejected = path;
      expect(restrict).toBe(true); expect(path).not.toBe(earlier);
      expect(readFileSync(path)).toEqual(Buffer.alloc(0));
      throw new Error("fictional Windows ACL failure");
    }
  });
  expect(() => saveAskAttachment(root, input)).toThrow(/file copy could not be saved/);
  expect(rejected).not.toBe(""); expect(existsSync(rejected)).toBe(false);
  expect(readdirSync(uploads)).toEqual(["earlier.csv"]);
  expect(readFileSync(earlier, "utf8")).toBe("earlier selected bytes");
});
