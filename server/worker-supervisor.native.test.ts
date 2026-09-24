// Native evidence only: these tests require the helper compiled by
// `pnpm build:worker:win` on Windows 10+ (release target: Windows 11 x64).
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { windowsWorkerSupervisor } from "./one-shot-process.ts";
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function expectGone(pid: number) {
  let alive = true;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") { alive = false; break; } throw error; }
    await pause(20);
  }
  if (alive) try { process.kill(pid, "SIGKILL"); } catch { /* owned fixture already exited */ }
  expect(alive, `owned fixture process ${pid} survived`).toBe(false);
}
function close(child: ChildProcess) {
  return new Promise<number | null>((resolve, reject) => {
    const cap = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("native fixture did not close within 5 seconds")); }, 5_000);
    child.once("error", error => { clearTimeout(cap); reject(error); });
    child.once("close", code => { clearTimeout(cap); resolve(code); });
  });
}
const tree = `const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e','setInterval(()=>{},100);setTimeout(()=>process.exit(77),15000);'],{stdio:['ignore','inherit','inherit']});
child.once('spawn',()=>console.log(JSON.stringify({leader:process.pid,descendant:child.pid})));
setInterval(()=>{},100);`;
function firstLine(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const cap = setTimeout(() => reject(new Error("native fixture did not become ready")), 4_000);
    child.stdout!.on("data", chunk => { output += String(chunk); if (output.includes("\n")) { clearTimeout(cap); resolve(output.split("\n")[0]); } });
    child.once("error", error => { clearTimeout(cap); reject(error); });
    child.once("exit", code => { if (!output.includes("\n")) { clearTimeout(cap); reject(new Error(`native fixture exited before readiness: ${code}`)); } });
  });
}

describe.skipIf(process.platform !== "win32")("native Windows Job Object supervisor", () => {
  it("reports its version without creating a worker", async () => {
    const output = await new Promise<string>((resolve, reject) => execFile(windowsWorkerSupervisor(), ["--version"], { timeout: 3_000 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
    expect(output.trim()).toBe("realbud-worker-supervisor 1");
  });

  it.each(["worker.exe", "C:worker.exe", "\\worker.exe", "C:\\fictional-missing-realbud-worker\\worker.exe"])("fails closed for an unresolved target %s", async target => {
    const child = spawn(windowsWorkerSupervisor(), ["--", target], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let output = ""; child.stdout.on("data", chunk => { output += String(chunk); });
    expect(await close(child)).toBe(125); expect(output).toBe("");
  });

  it.each(["control EOF", "supervisor death"])("cleans a live worker and inherited-pipe descendant on %s", async mode => {
    const child = spawn(windowsWorkerSupervisor(), ["--", process.execPath, "-e", tree], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const completion = close(child);
    try {
      const pids = JSON.parse(await firstLine(child));
      if (mode === "control EOF") child.stdin.end(); else child.kill("SIGKILL");
      expect(await completion).not.toBe(0);
      await expectGone(pids.descendant); await expectGone(pids.leader);
    } finally { child.kill("SIGKILL"); await completion.catch(() => {}); }
  }, 10_000);

  it("ends the job when its owning Node server dies and closes the control pipe", async () => {
    const ownerSource = `const {spawn}=require('node:child_process');
const helper=spawn(process.argv[1],['--',process.execPath,'-e',process.argv[2]],{stdio:['pipe','pipe','inherit'],windowsHide:true});
let output='';helper.stdout.on('data',chunk=>{output+=String(chunk);if(output.includes('\\n'))process.stdout.write(JSON.stringify({supervisor:helper.pid,output:output.split('\\n')[0]})+'\\n');});
setInterval(()=>{},100);`;
    const owner = spawn(process.execPath, ["-e", ownerSource, windowsWorkerSupervisor(), tree], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const completion = close(owner);
    try {
      const receipt = JSON.parse(await firstLine(owner)); const pids = JSON.parse(receipt.output.trim());
      owner.kill("SIGKILL"); await completion;
      await expectGone(pids.descendant); await expectGone(pids.leader); await expectGone(receipt.supervisor);
    } finally { owner.kill("SIGKILL"); await completion.catch(() => {}); }
  }, 10_000);
});
