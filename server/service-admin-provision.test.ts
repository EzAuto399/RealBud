import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { readServiceAdminPolicy, verifyServiceAdminPassword } from "./service-admin.ts";
import { privateDir, removeFixture } from "./testing/private-fixture.ts";

const root = mkdtempSync(join(tmpdir(), "realbud-admin-provision-test-"));
const script = join(dirname(fileURLToPath(import.meta.url)), "../scripts/provision-service-admin.mjs");
const helpers = await import(pathToFileURL(script).href);
const PASSWORD = "Fictional-provisioning-password-482!";
const NEXT_PASSWORD = "Different-fictional-password-927!";
let index = 0;
const directory = () => join(root, `case-${++index}`);
const policy = (dir: string) => join(dir, "service-admin.json");
function run(args: string[], input: string | Buffer = "") {
  return spawnSync(process.execPath, [script, ...args], { input, encoding: "utf8", timeout: 15_000, maxBuffer: 8192, windowsHide: true });
}
function provision(dir: string, password: string | Buffer = PASSWORD, flags: string[] = []) {
  return run(["--data-dir", dir, "--password-stdin", ...flags], password);
}
// An operator-made private folder: on Windows it gets its own protected descriptor,
// which the provisioner verifies before using an existing folder.
function privateDirectory(dir: string) { privateDir(dir); if (process.platform !== "win32") chmodSync(dir, 0o700); }
function cleanOutput(result: ReturnType<typeof run>) {
  const output = `${result.stdout}${result.stderr}`;
  expect(output).not.toContain(PASSWORD);
  expect(output).not.toContain(NEXT_PASSWORD);
  expect(output).not.toContain("scrypt$");
  return output;
}
afterAll(() => removeFixture(root));

// scripts/provision-service-admin.mjs refuses to run below Node 24, and
// package.json declares engines.node ">=24". On an older runtime every CLI case
// below exited through that guard. That did not only fail the cases expecting
// success — it also made the cases expecting exit 1 PASS FOR THE WRONG REASON,
// because the guard also exits 1. Both are worse than a visible skip, so the CLI
// block declares its runtime requirement instead of quietly mis-testing.
//
// This is an environment gap, not a defect to code around: the provisioner itself
// is not Node-24-specific — run with the guard bypassed on v22.22.0 it provisioned
// service-admin.json at mode 0600 correctly. Raising the runtime clears the skip.
const needsNode24 = Number(process.versions.node.split(".")[0]) < 24;

describe.skipIf(needsNode24)("trusted service administrator provisioning CLI", () => {
  it("generates independent passwords in private operator files for two installations", async () => {
    const operator = directory(); privateDirectory(operator);
    const credentials: string[] = [];
    const dirs: string[] = [];
    for (const name of ["A", "B"]) {
      const dir = directory(); dirs.push(dir);
      const receipt = join(operator, `${name}.txt`);
      const result = run(["--data-dir", dir, "--generate-password-file", receipt]);
      expect(result.status, cleanOutput(result)).toBe(0);
      const password = readFileSync(receipt, "utf8").trim(); credentials.push(password);
      expect(password).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(`${result.stdout}${result.stderr}`).not.toContain(password);
      expect(await verifyServiceAdminPassword(password, readServiceAdminPolicy({ path: policy(dir) }).passwordVerifier!)).toBe(true);
      expect(readdirSync(dir)).toEqual(["service-admin.json"]);
      if (process.platform !== "win32") expect(statSync(receipt).mode & 0o777).toBe(0o600);
    }
    expect(credentials[0]).not.toBe(credentials[1]);
    expect(await verifyServiceAdminPassword(credentials[0]!, readServiceAdminPolicy({ path: policy(dirs[1]!) }).passwordVerifier!)).toBe(false);
  });

  it("never ships a generated password inside the customer data directory or overwrites an operator file", () => {
    const dir = directory(); privateDirectory(dir);
    const inside = run(["--data-dir", dir, "--generate-password-file", join(dir, "password.txt")]);
    expect(inside.status).toBe(1);
    expect(cleanOutput(inside)).toContain("outside the installation");
    expect(existsSync(policy(dir))).toBe(false);
    const operator = directory(); privateDirectory(operator);
    const receipt = join(operator, "existing.txt"); writeFileSync(receipt, "preserve existing", { mode: 0o600 });
    const refused = run(["--data-dir", dir, "--generate-password-file", receipt]);
    expect(refused.status).toBe(1);
    expect(readFileSync(receipt, "utf8")).toBe("preserve existing");
    expect(existsSync(policy(dir))).toBe(false);
  });

  it("requires explicit rotation before generating a replacement password", () => {
    const dir = directory(); expect(provision(dir).status).toBe(0);
    const before = readFileSync(policy(dir));
    const operator = directory(); privateDirectory(operator);
    const receipt = join(operator, "new.txt");
    const refused = run(["--data-dir", dir, "--generate-password-file", receipt]);
    expect(refused.status).toBe(1);
    expect(existsSync(receipt)).toBe(false);
    expect(readFileSync(policy(dir))).toEqual(before);
    const rotated = run(["--data-dir", dir, "--generate-password-file", receipt, "--rotate"]);
    expect(rotated.status, cleanOutput(rotated)).toBe(0);
    expect(readFileSync(policy(dir))).not.toEqual(before);
  });

  it("creates a usable verifier in an explicitly selected private directory without printing credentials", async () => {
    const dir = join(directory(), "nested");
    const result = provision(dir, `${PASSWORD}\n`);
    expect(result.status, cleanOutput(result)).toBe(0);
    const saved = readServiceAdminPolicy({ path: policy(dir) });
    expect(saved.managed).toBe(true);
    expect(saved.passwordVerifier).toBeTruthy();
    expect(await verifyServiceAdminPassword(PASSWORD, saved.passwordVerifier!)).toBe(true);
    expect(readFileSync(policy(dir), "utf8")).not.toContain(PASSWORD);
    expect(readdirSync(dir)).toEqual(["service-admin.json"]);
    if (process.platform !== "win32") {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(dirname(dir)).mode & 0o777).toBe(0o700);
      expect(statSync(policy(dir)).mode & 0o777).toBe(0o600);
    }
  });

  it("never overwrites existing credentials without explicit rotation", async () => {
    const dir = directory();
    expect(provision(dir).status).toBe(0);
    const before = readFileSync(policy(dir));
    const refused = provision(dir, NEXT_PASSWORD);
    expect(refused.status).toBe(1);
    expect(cleanOutput(refused)).toContain("--rotate");
    expect(readFileSync(policy(dir))).toEqual(before);
    const rotated = provision(dir, NEXT_PASSWORD, ["--rotate"]);
    expect(rotated.status, cleanOutput(rotated)).toBe(0);
    const saved = readServiceAdminPolicy({ path: policy(dir) });
    expect(await verifyServiceAdminPassword(NEXT_PASSWORD, saved.passwordVerifier!)).toBe(true);
    expect(await verifyServiceAdminPassword(PASSWORD, saved.passwordVerifier!)).toBe(false);
    expect(readdirSync(dir)).toEqual(["service-admin.json"]);
  });

  it.each([
    [[], "explicit"],
    [["--data-dir", "relative-path", "--password-stdin"], "absolute"],
    [["--data-dir", "/", "--password-stdin"], "private"],
    [["--data-dir", root, "--password", PASSWORD], "never pass a password"],
    [["--data-dir", root, "--password-stdin", "--migrate-care"], "either"],
    [["--data-dir", root, "--rotate", "--rotate"], "only once"],
  ])("rejects unsafe or ambiguous arguments without reflecting them (%#)", (args, message) => {
    const result = run(args);
    expect(result.status).toBe(1);
    expect(cleanOutput(result)).toContain(message);
  });

  it("requires an explicit stdin opt-in when there is no interactive terminal", () => {
    const dir = directory();
    const result = run(["--data-dir", dir], PASSWORD);
    expect(result.status).toBe(1);
    expect(cleanOutput(result)).toContain("--password-stdin");
    expect(existsSync(policy(dir))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each(["short", "x".repeat(513), "界".repeat(350), `${PASSWORD}\nsecond line`, Buffer.from([0xff, 0xfe])])("rejects weak, oversized, multiline and invalid UTF-8 input (%#)", input => {
    const dir = directory();
    const result = provision(dir, input);
    expect(result.status).toBe(1);
    cleanOutput(result);
    expect(existsSync(policy(dir))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("leaves the old verifier unchanged when rotation input is invalid", () => {
    const dir = directory();
    expect(provision(dir).status).toBe(0);
    const before = readFileSync(policy(dir));
    expect(provision(dir, "short", ["--rotate"]).status).toBe(1);
    expect(readFileSync(policy(dir))).toEqual(before);
    expect(readdirSync(dir)).toEqual(["service-admin.json"]);
  });

  it("migrates the explicitly selected legacy unlock and preserves every original byte", async () => {
    const dir = directory(); privateDirectory(dir);
    const original = ` { "unlock": "${PASSWORD}", "preserved": {"mode": "example"} }\n`;
    writeFileSync(join(dir, "care.json"), original, { mode: 0o600 });
    const result = run(["--data-dir", dir, "--migrate-care"]);
    expect(result.status, cleanOutput(result)).toBe(0);
    expect(readFileSync(join(dir, "care.json"), "utf8")).toBe(original);
    const saved = readServiceAdminPolicy({ path: policy(dir) });
    expect(await verifyServiceAdminPassword(PASSWORD, saved.passwordVerifier!)).toBe(true);
  });

  it("does not implicitly migrate legacy credentials or accept malformed legacy data", () => {
    const dir = directory(); privateDirectory(dir);
    const path = join(dir, "care.json");
    writeFileSync(path, JSON.stringify({ unlock: PASSWORD }), { mode: 0o600 });
    expect(run(["--data-dir", dir]).status).toBe(1);
    expect(existsSync(policy(dir))).toBe(false);
    for (const content of ["{", JSON.stringify({ other: PASSWORD }), JSON.stringify({ unlock: "short" }), " ".repeat(65_537)]) {
      writeFileSync(path, content, { mode: 0o600 });
      const result = run(["--data-dir", dir, "--migrate-care"]);
      expect(result.status).toBe(1);
      cleanOutput(result);
      expect(readFileSync(path, "utf8")).toBe(content);
      expect(existsSync(policy(dir))).toBe(false);
    }
  });

  it("preserves an existing operation lock rather than racing a concurrent provisioner", () => {
    const dir = directory(); privateDirectory(dir);
    const lock = join(dir, ".service-admin-provision.lock");
    writeFileSync(lock, "another operation", { mode: 0o600 });
    const result = provision(dir);
    expect(result.status).toBe(1);
    expect(cleanOutput(result)).toContain("locked");
    expect(readFileSync(lock, "utf8")).toBe("another operation");
    expect(existsSync(policy(dir))).toBe(false);
  });

  it("allows only one of two concurrent initial provisioners to publish credentials", async () => {
    const dir = directory(); privateDirectory(dir);
    const attempt = (password: string) => new Promise<{ code: number | null; output: string }>((resolveAttempt, reject) => {
      const child = spawn(process.execPath, [script, "--data-dir", dir, "--password-stdin"], { stdio: "pipe", windowsHide: true });
      let output = "";
      child.stdout.on("data", value => { output += value; });
      child.stderr.on("data", value => { output += value; });
      child.once("error", reject);
      child.once("close", code => resolveAttempt({ code, output }));
      child.stdin.end(password);
    });
    const results = await Promise.all([attempt(PASSWORD), attempt(NEXT_PASSWORD)]);
    expect(results.map(result => result.code).sort()).toEqual([0, 1]);
    for (const result of results) { expect(result.output).not.toContain(PASSWORD); expect(result.output).not.toContain(NEXT_PASSWORD); expect(result.output).not.toContain("scrypt$"); }
    const saved = readServiceAdminPolicy({ path: policy(dir) });
    const valid = await Promise.all([verifyServiceAdminPassword(PASSWORD, saved.passwordVerifier!), verifyServiceAdminPassword(NEXT_PASSWORD, saved.passwordVerifier!)]);
    expect(valid.filter(Boolean)).toHaveLength(1);
    expect(readdirSync(dir)).toEqual(["service-admin.json"]);
  });

  it.skipIf(process.platform === "win32")("refuses a nonprivate directory without silently changing its permissions", () => {
    const dir = directory(); mkdirSync(dir); chmodSync(dir, 0o755);
    const result = provision(dir);
    expect(result.status).toBe(1);
    expect(cleanOutput(result)).toContain("private data directory");
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    expect(readdirSync(dir)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("rejects directory and policy symlinks without changing their targets", () => {
    const real = directory(); privateDirectory(real);
    const alias = directory(); symlinkSync(real, alias);
    expect(provision(alias).status).toBe(1);
    const target = join(root, "untouched.json"); writeFileSync(target, "unchanged", { mode: 0o600 });
    symlinkSync(target, policy(real));
    const result = provision(real, PASSWORD, ["--rotate"]);
    expect(result.status).toBe(1); cleanOutput(result);
    expect(readFileSync(target, "utf8")).toBe("unchanged");
  });

  it("rejects multiply linked administrator files", () => {
    const dir = directory(); privateDirectory(dir);
    const original = join(root, "hardlink-source.json"); writeFileSync(original, "unchanged", { mode: 0o600 });
    linkSync(original, policy(dir));
    const result = provision(dir, PASSWORD, ["--rotate"]);
    expect(result.status).toBe(1); cleanOutput(result);
    expect(readFileSync(original, "utf8")).toBe("unchanged");
  });
});

describe("bounded hidden password input", () => {
  class FakeTerminal extends PassThrough {
    isTTY = true;
    isRaw = false;
    setRawMode(value: boolean) { this.isRaw = value; return this; }
  }
  it("disables echo before the prompt, restores terminal mode and supports Unicode/backspace", async () => {
    const input = new FakeTerminal();
    let printed = "";
    const output = { isTTY: true, write(text: string) { if (text !== "\n") expect(input.isRaw).toBe(true); printed += text; } };
    const reading = helpers.readHiddenPassword(input, output, "Password: ");
    input.write(Buffer.from("例x\u007f-password\r"));
    expect(await reading).toBe("例-password");
    expect(printed).toBe("Password: \n");
    expect(input.isRaw).toBe(false);
    expect(input.listenerCount("data")).toBe(0);
  });

  it("restores terminal mode on cancellation without echoing typed text", async () => {
    const input = new FakeTerminal(); let printed = "";
    const reading = helpers.readHiddenPassword(input, { isTTY: true, write(text: string) { printed += text; } }, "Password: ");
    const assertion = expect(reading).rejects.toThrow("cancelled");
    input.write(`${PASSWORD}\u0003`);
    await assertion;
    expect(printed).not.toContain(PASSWORD);
    expect(input.isRaw).toBe(false);
  });

  it("limits streamed input before an unbounded source can be fully read", async () => {
    let chunksRead = 0;
    const stream = Readable.from((function* () { for (let count = 0; count < 100; count++) { chunksRead++; yield Buffer.alloc(1024, 120); } })());
    await expect(helpers.readBoundedPasswordStdin(stream)).rejects.toThrow("1024 bytes");
    expect(chunksRead).toBeLessThan(100);
  });

  it("requires matching hidden confirmation before any verifier is saved", async () => {
    const dir = directory();
    const input = new FakeTerminal();
    let printed = "";
    const output = { isTTY: true, write(text: string) {
      printed += text;
      if (text.startsWith("Unique")) queueMicrotask(() => input.write(`${PASSWORD}\r`));
      if (text.startsWith("Confirm")) queueMicrotask(() => input.write(`${NEXT_PASSWORD}\r`));
    } };
    await expect(helpers.provisionServiceAdmin({ dataDir: dir, rotate: false, passwordStdin: false, migrateCare: false }, { input, output })).rejects.toThrow("did not match");
    expect(printed).not.toContain(PASSWORD); expect(printed).not.toContain(NEXT_PASSWORD);
    expect(input.isRaw).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
});
