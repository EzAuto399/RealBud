import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DocumentDepsError, DOCUMENT_TOOLS_NEED_REPAIR, DOCUMENT_TOOLS_READY, DOCUMENT_TOOLS_RUNTIME_UNSUPPORTED, DOCUMENT_TOOLS_UNSUPPORTED, documentDepsLock, documentRuntimeRefusal,
  documentToolsStatus, ensureDocumentDeps, ownedRuntimeHome, parseDocumentDepsLock, repairDocumentDeps, runtimePython, selectDocumentWheels, type DocumentDepsLock, type PythonRun,
} from "./hermes-document-deps.ts";
import { runtimeCli } from "./hermes-paths.ts";
import { releaseHome, saveRuntimeSelection } from "./hermes-runtime-selection.ts";

const roots: string[] = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), "realbud-document-deps-test-")); roots.push(path); return path; };
/** A reviewed release's own runtime folder with an intact venv (0.21.5's commit). */
const RELEASE = "f97608f178d1ffeca59860195ab7da295f7c8e5f";
const runtime = (commit = RELEASE) => {
  const home = join(root(), "runtimes", commit), venv = join(home, "hermes-agent", "venv");
  mkdirSync(venv, { recursive: true }); writeFileSync(join(venv, "pyvenv.cfg"), "home = /synthetic/python\n");
  return home;
};
afterEach(() => { vi.unstubAllEnvs(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

const bytesFor = (filename: string) => Buffer.from(`fictional wheel ${filename}`);
const wheel = (filename: string, targets: string[]) => {
  const bytes = bytesFor(filename);
  return { filename, url: `https://files.pythonhosted.org/packages/fictional/${filename}`, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, targets };
};
const lock: DocumentDepsLock = parseDocumentDepsLock({
  version: 1, purpose: "realbud-hermes-document-deps", pythons: ["cp311"], targets: ["darwin-arm64", "darwin-x64", "win32-x64"],
  installer: { name: "pip", version: "1.0.0", license: "MIT", wheel: wheel("pip-1.0.0-py3-none-any.whl", ["any"]) },
  packages: [
    { name: "fictional-pure", version: "1.0.0", import: "fictional_pure", license: "MIT", wheels: [wheel("fictional_pure-1.0.0-py3-none-any.whl", ["any"])] },
    { name: "fictional-native", version: "2.0.0", import: "fictional_native", license: "BSD-3-Clause", wheels: [
      wheel("fictional_native-2.0.0-cp311-cp311-macosx_11_0_arm64.whl", ["darwin-arm64-cp311"]),
      wheel("fictional_native-2.0.0-cp311-cp311-macosx_10_9_x86_64.whl", ["darwin-x64-cp311"]),
      wheel("fictional_native-2.0.0-cp311-cp311-win_amd64.whl", ["win32-x64-cp311"]),
    ] },
  ],
  runtimeProvided: [{ name: "fictional-base", import: "fictional_base", minimum: "3.0", license: "MIT" }],
});

type Fake = { installed: Record<string, string>; machine?: string; platform?: string; venv?: boolean; prefix?: string; provided?: string | null; installs: string[][]; pythons: string[]; requirements?: string; wheelFiles?: string[]; scratch?: string };
function fakePython(fake: Fake): PythonRun {
  return async (python, args, options) => {
    fake.pythons.push(python);
    fake.scratch = options.cwd;
    expect(options.env.PYTHONNOUSERSITE).toBe("1");
    expect(args[0]).toBe("-I");
    if (args.includes("install")) {
      fake.installs.push(args);
      const dir = args[args.indexOf("--find-links") + 1];
      fake.wheelFiles = readdirSync(dir).sort();
      for (const file of fake.wheelFiles) expect(readFileSync(join(dir, file))).toEqual(bytesFor(file));
      fake.requirements = readFileSync(args[args.indexOf("-r") + 1], "utf8");
      for (const item of lock.packages) fake.installed[item.name] = item.version;
      return "";
    }
    const state = (names: string[], source: Record<string, string | null>) =>
      Object.fromEntries(names.map(token => token.split(":")[0]).map(name => [name, { version: source[name] ?? null, imports: Boolean(source[name]) }]));
    const split = args.indexOf("--provided");
    // A venv interpreter reports its own venv (two folders above it) as sys.prefix.
    return JSON.stringify({ implementation: "cpython", python: "cp311", platform: fake.platform ?? "darwin", machine: fake.machine ?? "arm64", venv: fake.venv ?? true, prefix: fake.prefix ?? dirname(dirname(python)),
      packages: state(args.slice(2, split), fake.installed), provided: state(args.slice(split + 1), { "fictional-base": fake.provided === undefined ? "3.1.0" : fake.provided }) }) + "\n";
  };
}
function fakeRequest(tamper?: string) {
  const urls: string[] = [];
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    expect(init?.redirect).toBe("error");
    const filename = String(url).split("/").pop()!;
    urls.push(filename);
    const bytes = filename === tamper ? Buffer.from(bytesFor(filename).toString().replace("fictional", "fictioNal")) : bytesFor(filename);
    return new Response(bytes);
  }) as typeof fetch;
  return { request, urls };
}
const fake = (extra: Partial<Fake> = {}): Fake => ({ installed: {}, installs: [], pythons: [], ...extra });

describe("ensureDocumentDeps", () => {
  it("installs only the current platform's verified wheels with the venv's own Python and pip wheel", async () => {
    const home = runtime(), state = fake(), net = fakeRequest();
    const result = await ensureDocumentDeps(home, { platform: "darwin", run: fakePython(state), request: net.request, lock });
    expect(result).toEqual({ state: "ready", installed: true, target: "darwin-arm64-cp311" });
    expect(net.urls).toEqual(["pip-1.0.0-py3-none-any.whl", "fictional_pure-1.0.0-py3-none-any.whl", "fictional_native-2.0.0-cp311-cp311-macosx_11_0_arm64.whl"]);
    expect(new Set(state.pythons)).toEqual(new Set([join(home, "hermes-agent", "venv", "bin", "python")]));
    const [args] = state.installs;
    expect(args[1]).toBe(join(args[args.indexOf("--find-links") + 1], "pip-1.0.0-py3-none-any.whl", "pip"));
    expect(args).toEqual(expect.arrayContaining(["install", "--isolated", "--no-index", "--no-deps", "--require-hashes", "--only-binary=:all:"]));
    expect(state.requirements).toBe(lock.packages.map(item => {
      const chosen = item.wheels.find(entry => entry.targets.includes("any") || entry.targets.includes("darwin-arm64-cp311"))!;
      return `${item.name}==${item.version} --hash=sha256:${chosen.sha256}\n`;
    }).join(""));
    expect(state.wheelFiles).not.toContain("fictional_native-2.0.0-cp311-cp311-win_amd64.whl");
    expect(existsSync(state.scratch!)).toBe(false);
  });

  it("selects the interpreter's own platform: Intel Mac and Windows python.exe", async () => {
    const intel = fake({ machine: "x86_64" }), intelNet = fakeRequest();
    await expect(ensureDocumentDeps(runtime(), { platform: "darwin", run: fakePython(intel), request: intelNet.request, lock })).resolves.toMatchObject({ target: "darwin-x64-cp311" });
    expect(intelNet.urls).toContain("fictional_native-2.0.0-cp311-cp311-macosx_10_9_x86_64.whl");

    const home = runtime(), windows = fake({ platform: "win32", machine: "AMD64" }), windowsNet = fakeRequest();
    await expect(ensureDocumentDeps(home, { platform: "win32", run: fakePython(windows), request: windowsNet.request, lock })).resolves.toMatchObject({ target: "win32-x64-cp311" });
    expect(runtimePython(home, "win32")).toBe(join(home, "hermes-agent", "venv", "Scripts", "python.exe"));
    expect(new Set(windows.pythons)).toEqual(new Set([join(home, "hermes-agent", "venv", "Scripts", "python.exe")]));
    expect(windowsNet.urls).toContain("fictional_native-2.0.0-cp311-cp311-win_amd64.whl");
    expect(windowsNet.urls).not.toContain("fictional_native-2.0.0-cp311-cp311-macosx_11_0_arm64.whl");
  });

  it("refuses a wheel whose bytes do not match the lock and installs nothing", async () => {
    const state = fake(), net = fakeRequest("fictional_native-2.0.0-cp311-cp311-macosx_11_0_arm64.whl");
    await expect(ensureDocumentDeps(runtime(), { platform: "darwin", run: fakePython(state), request: net.request, lock })).rejects.toThrow(/didn’t match the reviewed version/);
    expect(state.installs).toEqual([]);
    expect(existsSync(state.scratch!)).toBe(false);
  });

  it("skips downloads and pip when the locked versions already import", async () => {
    const state = fake({ installed: { "fictional-pure": "1.0.0", "fictional-native": "2.0.0" } }), net = fakeRequest();
    await expect(ensureDocumentDeps(runtime(), { platform: "darwin", run: fakePython(state), request: net.request, lock })).resolves.toEqual({ state: "ready", installed: false, target: "darwin-arm64-cp311" });
    expect(net.urls).toEqual([]);
    expect(state.installs).toEqual([]);
  });

  it("replaces a different installed version with the locked one", async () => {
    const state = fake({ installed: { "fictional-pure": "0.9.0", "fictional-native": "2.0.0" } }), net = fakeRequest();
    await expect(ensureDocumentDeps(runtime(), { platform: "darwin", run: fakePython(state), request: net.request, lock })).resolves.toMatchObject({ installed: true });
    expect(state.installs).toHaveLength(1);
  });

  it("does not install on an unsupported platform, outside a venv, or without the runtime's own dependencies", async () => {
    const linux = fake({ platform: "linux", machine: "x86_64" }), net = fakeRequest();
    await expect(ensureDocumentDeps(runtime(), { platform: "linux", run: fakePython(linux), request: net.request, lock })).resolves.toEqual({ state: "unsupported", detail: DOCUMENT_TOOLS_UNSUPPORTED });
    await expect(ensureDocumentDeps(runtime(), { platform: "darwin", run: fakePython(fake({ venv: false })), request: net.request, lock })).rejects.toThrow(/not a private environment/);
    await expect(ensureDocumentDeps(runtime(), { platform: "darwin", run: fakePython(fake({ provided: "2.9" })), request: net.request, lock })).rejects.toThrow(/missing parts/);
    expect(net.urls).toEqual([]);
  });

  it("reports failure, never ready, when pip leaves the libraries missing", async () => {
    const state = fake(), base = fakePython(state);
    const run: PythonRun = async (python, args, options) => { const out = await base(python, args, options); if (args.includes("install")) state.installed = {}; return out; };
    await expect(ensureDocumentDeps(runtime(), { platform: "darwin", run, request: fakeRequest().request, lock })).rejects.toThrow(/did not finish installing/);
  });

  it("never writes into a legacy, unknown or replaced runtime, and says so instead of failing", async () => {
    const legacy = root();
    mkdirSync(join(legacy, "hermes-agent", "venv"), { recursive: true }); writeFileSync(join(legacy, "hermes-agent", "venv", "pyvenv.cfg"), "");
    const unknown = runtime("0123456789abcdef0123456789abcdef01234567");
    const linked = runtime(); const outside = join(root(), "venv"); mkdirSync(outside);
    rmSync(join(linked, "hermes-agent", "venv"), { recursive: true }); symlinkSync(outside, join(linked, "hermes-agent", "venv"));
    const unmarked = runtime(); rmSync(join(unmarked, "hermes-agent", "venv", "pyvenv.cfg"));
    const deleted = runtime(); rmSync(dirname(dirname(deleted)), { recursive: true });
    for (const home of [legacy, unknown, linked, unmarked, deleted]) {
      expect(documentRuntimeRefusal(home), home).toBe(DOCUMENT_TOOLS_RUNTIME_UNSUPPORTED);
      const state = fake(), net = fakeRequest();
      await expect(ensureDocumentDeps(home, { platform: "darwin", run: fakePython(state), request: net.request, lock })).resolves.toEqual({ state: "unsupported", detail: DOCUMENT_TOOLS_RUNTIME_UNSUPPORTED });
      expect(state.pythons).toEqual([]); expect(net.urls).toEqual([]);
    }
    expect(documentRuntimeRefusal(runtime())).toBeNull();
    expect(documentRuntimeRefusal(runtime(`${RELEASE}-0123456789ab`))).toBeNull();
  });

  it("does not install when the interpreter's environment is not the runtime's own venv", async () => {
    const state = fake({ prefix: "/synthetic/other-env" }), net = fakeRequest();
    await expect(ensureDocumentDeps(runtime(), { platform: "darwin", run: fakePython(state), request: net.request, lock })).resolves.toEqual({ state: "unsupported", detail: DOCUMENT_TOOLS_RUNTIME_UNSUPPORTED });
    expect(state.installs).toEqual([]); expect(net.urls).toEqual([]);
  });

  it("never runs a real install in tests", async () => {
    await expect(ensureDocumentDeps(runtime())).rejects.toThrow(/disabled in automated tests/);
  });
});

describe("documentToolsStatus", () => {
  it("reads ready, needs Repair, or a failed check as needs Repair", async () => {
    await expect(documentToolsStatus(runtime(), { platform: "darwin", run: fakePython(fake({ installed: { "fictional-pure": "1.0.0", "fictional-native": "2.0.0" } })), lock })).resolves.toEqual({ ready: true, detail: DOCUMENT_TOOLS_READY });
    await expect(documentToolsStatus(runtime(), { platform: "darwin", run: fakePython(fake()), lock })).resolves.toEqual({ ready: false, detail: DOCUMENT_TOOLS_NEED_REPAIR });
    await expect(documentToolsStatus(runtime(), { platform: "darwin", run: async () => { throw new Error("fictional spawn failure"); }, lock })).resolves.toEqual({ ready: false, detail: DOCUMENT_TOOLS_NEED_REPAIR });
  });
  it("reads a runtime Repair must not change as unavailable here, never as needing Repair, unless it already has the libraries", async () => {
    const legacy = root();
    await expect(documentToolsStatus(legacy, { platform: "darwin", run: fakePython(fake()), lock })).resolves.toEqual({ ready: false, detail: DOCUMENT_TOOLS_UNSUPPORTED });
    await expect(documentToolsStatus(legacy, { platform: "darwin", run: fakePython(fake({ installed: { "fictional-pure": "1.0.0", "fictional-native": "2.0.0" } })), lock })).resolves.toEqual({ ready: true, detail: DOCUMENT_TOOLS_READY });
  });
});

describe("repairDocumentDeps", () => {
  const commit = `${"a".repeat(40)}-${"b".repeat(12)}`;
  it("adds the libraries to RealBud's selected runtime only", async () => {
    const home = root();
    const ensure = vi.fn(async () => ({ state: "ready" as const, installed: true, target: "darwin-arm64-cp311" }));
    await expect(repairDocumentDeps(home, ensure)).resolves.toBeNull();
    expect(ensure).not.toHaveBeenCalled();
    saveRuntimeSelection(home, { version: 1, selected: commit, previous: null });
    expect(ownedRuntimeHome(home)).toBe(releaseHome(home, commit));
    await expect(repairDocumentDeps(home, ensure)).resolves.toBeNull();
    expect(ensure).toHaveBeenCalledWith(releaseHome(home, commit));
    vi.stubEnv("REALBUD_HERMES_CLI", "/synthetic/custom/hermes");
    expect(ownedRuntimeHome(home)).toBeNull();
  });

  it("uses the legacy owned runtime and reports a failure without throwing", async () => {
    const home = root();
    mkdirSync(dirname(runtimeCli(home)), { recursive: true });
    writeFileSync(runtimeCli(home), "");
    const ensure = vi.fn(async () => { throw new DocumentDepsError("Couldn’t download document tools."); });
    await expect(repairDocumentDeps(home, ensure)).resolves.toBe(`${DOCUMENT_TOOLS_NEED_REPAIR} Couldn’t download document tools.`);
    expect(ensure).toHaveBeenCalledWith(home);
  });
});

describe("reviewed lock", () => {
  const reviewed = documentDepsLock();
  it("covers every package on every supported Mac and Windows Python", () => {
    for (const target of reviewed.targets) for (const python of reviewed.pythons) {
      const chosen = selectDocumentWheels(reviewed, `${target}-${python}`);
      expect(chosen, `${target}-${python}`).not.toBeNull();
    }
    expect(selectDocumentWheels(reviewed, "linux-x64-cp311")).toBeNull();
  });
  it("names exactly the skills' libraries, excludes copyleft PDF engines and pins every wheel", () => {
    expect(reviewed.packages.map(item => item.name).sort()).toEqual(["et-xmlfile", "lxml", "openpyxl", "pdfminer.six", "pdfplumber", "pypdf", "pypdfium2", "python-docx", "python-pptx", "reportlab", "xlsxwriter"]);
    // The powerpoint skill imports `pptx`; readiness is that live import.
    expect(reviewed.packages.find(item => item.name === "python-pptx")?.import).toBe("pptx");
    const names = JSON.stringify(reviewed).toLowerCase();
    expect(reviewed.packages.some(item => /mupdf|marker/i.test(item.name))).toBe(false);
    expect(names).not.toMatch(/"license":\s*"[^"]*\bA?GPL/);
    for (const item of [...reviewed.packages.flatMap(entry => entry.wheels), reviewed.installer.wheel]) {
      expect(item.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(new URL(item.url).hostname).toBe("files.pythonhosted.org");
    }
    expect(dirname(runtimePython("/synthetic/runtime", "darwin"))).toBe(join("/synthetic/runtime", "hermes-agent", "venv", "bin"));
  });
  it("rejects a lock that points anywhere but PyPI's file host", () => {
    const tampered = JSON.parse(JSON.stringify(reviewed));
    tampered.packages[0].wheels[0].url = tampered.packages[0].wheels[0].url.replace("files.pythonhosted.org", "example.invalid");
    expect(() => parseDocumentDepsLock(tampered)).toThrow(/could not be read/);
  });
});
