import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyServiceOutput, classifyStartError, readServiceOutputTail, startProblemCopy, startProblemPage } from "./service-start-problem.mjs";

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const decode = (url) => decodeURIComponent(url.slice("data:text/html;charset=utf-8,".length));
const options = { dataDirectory: "/synthetic/home/.realbud", ports: [8799, 18799, 28799], platform: "darwin" };

describe("startup problems with a known cause", () => {
  it("classifies thrown errors by code, then by message", () => {
    expect(classifyStartError(Object.assign(new Error("EACCES: permission denied, mkdir '/synthetic/ro/.realbud'"), { code: "EACCES" }))).toBe("no-access");
    expect(classifyStartError(Object.assign(new Error("read-only"), { code: "EROFS" }))).toBe("no-access");
    expect(classifyStartError(Object.assign(new Error("full"), { code: "ENOSPC" }))).toBe("disk-full");
    expect(classifyStartError(Object.assign(new Error("This Mac is out of space."), { code: "storage-full" }))).toBe("disk-full");
    expect(classifyStartError(new Error("spawn failed: EPERM"))).toBe("no-access");
    expect(classifyStartError(new Error("the workspace key is locked"))).toBeNull();
    expect(classifyStartError(undefined)).toBeNull();
  });

  it("reads only the latest start in the service output", () => {
    const earlier = "[t0] office service starting port=18799\nError: ENOSPC: no space left on device\n";
    const latestOk = "[t1] office service starting port=18799\nrealbud server on http://127.0.0.1:18799\n";
    expect(classifyServiceOutput(earlier)).toBe("disk-full");
    expect(classifyServiceOutput(earlier + latestOk)).toBeNull();
    expect(classifyServiceOutput(latestOk + "[t2] office service starting port=18799\n  code: 'storage-full'\n")).toBe("disk-full");
    expect(classifyServiceOutput("[t3] office service starting port=18799\nError: EACCES: permission denied, open '/synthetic/desk.json'\n")).toBe("no-access");
    expect(classifyServiceOutput("[t4] office service starting port=18799\nError: the company database did not open\n")).toBeNull();
  });

  it("reads the tail of our own service output file and never throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-start-problem-"));
    dirs.push(dir);
    expect(readServiceOutputTail(dir)).toBe("");
    mkdirSync(join(dir, "office-service"));
    writeFileSync(join(dir, "office-service", "stdout-stderr.log"), `${"x".repeat(100)}\n[t] office service starting port=1\ncode: 'storage-full'\n`);
    const tail = readServiceOutputTail(dir, 64);
    expect(tail.length).toBeLessThanOrEqual(64);
    expect(classifyServiceOutput(tail)).toBe("disk-full");
  });

  it("names the cause and one action on each page, with no retry promise", () => {
    for (const problem of ["disk-full", "no-access", "ports-taken"]) {
      const html = decode(startProblemPage(problem, options));
      expect(html).toMatch(/reopen RealBud/);
      expect(html).not.toMatch(/Waiting|next few minutes|keeps checking/i);
    }
    expect(startProblemCopy("disk-full", options).title).toBe("This Mac is out of space");
    expect(startProblemCopy("disk-full", { ...options, platform: "win32" }).title).toBe("This computer is out of space");
    expect(decode(startProblemPage("no-access", options))).toContain("/synthetic/home/.realbud");
    expect(decode(startProblemPage("ports-taken", options))).toContain("8799, 18799, 28799");
    expect(startProblemPage(null, options)).toBeNull();
  });

  it("escapes the data folder path", () => {
    const html = decode(startProblemPage("no-access", { ...options, dataDirectory: "/synthetic/<b>&\"x\"" }));
    expect(html).toContain("/synthetic/&lt;b&gt;&amp;&quot;x&quot;");
    expect(html).not.toContain("<b>&");
  });
});
