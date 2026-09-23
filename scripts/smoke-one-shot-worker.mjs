// Installed-runtime proof with fictional disposable Node workers only. This
// imports the packaged server module and never starts Hermes or a model call.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const pause = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}
async function waitGone(pid) {
  for (let attempt = 0; attempt < 100; attempt++) { if (!alive(pid)) return true; await pause(20); }
  return !alive(pid);
}

export async function smokeInstalledWorker(resources, executable) {
  assert.equal(process.platform, "win32", "installed worker proof requires native Windows");
  assert.equal(process.arch, "x64", "installed worker proof requires x64");
  resources = resolve(resources); executable = resolve(executable);
  const moduleFile = join(resources, "server", "one-shot-process.js");
  assert.ok(existsSync(moduleFile), "installed one-shot server module is missing");
  assert.ok(existsSync(executable), "installed Electron executable is missing");
  const { runOneShot, windowsWorkerSupervisor, WINDOWS_WORKER_SUPERVISOR } = await import(pathToFileURL(moduleFile).href);
  assert.equal(windowsWorkerSupervisor(), join(resources, WINDOWS_WORKER_SUPERVISOR), "worker must resolve the exact installed helper");
  const scratch = mkdtempSync(join(tmpdir(), "realbud-worker-smoke-")), checks = [];
  const appData = join(scratch, "AppData", "Roaming"), localAppData = join(scratch, "AppData", "Local");
  mkdirSync(appData, { recursive: true }); mkdirSync(localAppData, { recursive: true });
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  // Only OS bootstrapping and this throwaway user's paths enter the probe.
  // In particular, no ambient provider keys, NODE_OPTIONS or service tokens.
  const environment = {
    SystemRoot: systemRoot, WINDIR: systemRoot, PATH: join(systemRoot, "System32"),
    COMSPEC: join(systemRoot, "System32", "cmd.exe"), HOME: scratch, USERPROFILE: scratch,
    APPDATA: appData, LOCALAPPDATA: localAppData, TEMP: scratch, TMP: scratch,
    ELECTRON_RUN_AS_NODE: "1", FICTIONAL_SETTING: "fictional-worker-smoke",
  };
  const pendingChildren = new Set(), receiptFiles = [], confirmedGone = new Set();
  async function capture(script, args = [], timeout = 5_000) {
    let callbacks = 0, resolveResult, resolveClose, cap;
    const result = new Promise(done => { resolveResult = done; });
    const closed = new Promise(done => { resolveClose = done; });
    const child = runOneShot(executable, ["-e", script, "--", ...args], { cwd: scratch, env: environment, timeout, encoding: "utf8", maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => { callbacks++; resolveResult({ error, stdout, stderr }); });
    if (!child) resolveClose();
    else { pendingChildren.add(child); child.once("close", () => { pendingChildren.delete(child); resolveClose(); }); }
    const completion = result.then(async value => { await closed; assert.equal(callbacks, 1); return value; });
    const bounded = new Promise((_done, fail) => {
      cap = setTimeout(() => {
        child?.kill("SIGKILL"); child?.stdin?.destroy();
        fail(new Error("installed worker completion exceeded its bounded deadline"));
      }, timeout + 5_000);
    });
    try { return await Promise.race([completion, bounded]); }
    finally { clearTimeout(cap); }
  }
  async function assertReceiptGone(receiptFile) {
    const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
    const pids = [receipt.leader, ...receipt.descendants];
    for (const pid of pids) {
      assert.ok(Number.isInteger(pid) && pid > 0, "fixture receipt must contain an owned process id");
      assert.ok(await waitGone(pid), "an installed one-shot fixture survived containment"); confirmedGone.add(pid);
    }
    return receipt;
  }
  const tree = `
    const {spawn}=require('node:child_process'); const fs=require('node:fs');
    const modes=process.argv[2]==='normal' ? ['inherit','ignore'] : ['inherit'];
    const children=modes.map(mode=>spawn(process.execPath,['-e','setInterval(()=>{},100);setTimeout(()=>process.exit(77),30000);'],{stdio:['ignore',mode,mode],windowsHide:true}));
    Promise.all(children.map(child=>new Promise((done,fail)=>{child.once('spawn',done);child.once('error',fail);}))).then(()=>{
      const receipt={leader:process.pid,descendants:children.map(child=>child.pid)};
      fs.writeFileSync(process.argv[1],JSON.stringify(receipt)); console.log(JSON.stringify(receipt));
      if(process.argv[2]==='normal') process.exit(0);
      process.stdout.on('error',()=>process.exit(0)); setInterval(()=>process.stdout.write('fictional-active-output\\n'),20);
      setTimeout(()=>process.exit(77),30000);
    });
  `;
  try {
    const args = ["", "space inside", 'quote"inside', "tail\\", 'mixed\\\\\"quote', "line\nbreak", "文字😀", "&|<>^%!"];
    const exact = await capture("console.log(JSON.stringify({args:process.argv.slice(1),setting:process.env.FICTIONAL_SETTING}));console.error('fictional-stderr');process.exitCode=23;", args);
    assert.equal(exact.error?.code, 23); assert.equal(exact.error?.killed, false);
    assert.deepEqual(JSON.parse(exact.stdout), { args, setting: "fictional-worker-smoke" }); assert.equal(exact.stderr, "fictional-stderr\n");
    checks.push("Installed one-shot worker preserves difficult argv, UTF-8, environment, both streams and nonzero exit");

    const timeoutReceipt = join(scratch, "timeout.json"); receiptFiles.push(timeoutReceipt);
    const timeout = await capture(tree, [timeoutReceipt, "timeout"]);
    assert.equal(timeout.error?.code, "ETIMEDOUT"); assert.equal(timeout.error?.killed, true);
    assert.ok(timeout.stdout.includes("fictional-active-output"), "worker must be writing before its timeout");
    await assertReceiptGone(timeoutReceipt);
    checks.push("Installed worker timeout ends the active writer and its inherited-pipe descendant");

    const normalReceipt = join(scratch, "normal.json"); receiptFiles.push(normalReceipt);
    const normal = await capture(tree, [normalReceipt, "normal"]);
    assert.equal(normal.error, null); await assertReceiptGone(normalReceipt);
    checks.push("Installed worker zero exit cleans descendants with inherited pipes and with ignored stdio");
    assert.equal(pendingChildren.size, 0, "installed supervisor must close before smoke succeeds");
    return checks;
  } finally {
    // Test cleanup is limited to handles we spawned and receipts written in
    // this private throwaway directory. A failed assertion cannot leak probes.
    for (const child of pendingChildren) {
      child.kill("SIGKILL"); child.stdin?.destroy();
      if (child.pid) assert.ok(await waitGone(child.pid), "owned smoke supervisor could not be stopped");
      child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
    }
    for (const receiptFile of receiptFiles) {
      if (!existsSync(receiptFile)) continue;
      const receipt = JSON.parse(readFileSync(receiptFile, "utf8"));
      for (const pid of [receipt.leader, ...receipt.descendants]) {
        if (!Number.isInteger(pid) || pid <= 0 || confirmedGone.has(pid)) continue;
        if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
        assert.ok(await waitGone(pid), "owned smoke fixture could not be stopped");
      }
    }
    rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}
