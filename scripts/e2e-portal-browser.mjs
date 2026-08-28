#!/usr/bin/env node
// Visible Stage-0 portal proof. This is a QA driver, not a production tool:
// it uses an isolated agent-browser session to exercise the accessible fake
// portal while RealBud's server-owned handoff remains the authority boundary.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { portalRevoke } from "../server/portal-handoff.ts";
import { startFakePortal } from "../server/testing/fake-portal.ts";

const AGENT_BROWSER_PACKAGE = "agent-browser@0.27.0";

function resolveBrowserCommand() {
  const explicit = process.env.AGENT_BROWSER_BIN?.trim();
  if (explicit) return explicit;
  const local = fileURLToPath(new URL("../node_modules/agent-browser/bin/agent-browser.js", import.meta.url));
  if (existsSync(local)) return local;
  const probe = spawnSync("npm", [
    "exec",
    "--yes",
    `--package=${AGENT_BROWSER_PACKAGE}`,
    "--",
    "node",
    "-e",
    "const fs=require('fs'),p=require('path');for(const d of process.env.PATH.split(p.delimiter)){const f=p.join(d,'agent-browser');if(fs.existsSync(f)){process.stdout.write(f);break}}",
  ], { encoding: "utf8", timeout: 30_000 });
  if (probe.error) throw probe.error;
  const resolved = probe.stdout.trim();
  if (probe.status !== 0 || !resolved) {
    throw new Error(`agent-browser is unavailable: ${probe.stderr || "npm did not expose its CLI"}`);
  }
  return resolved;
}

const command = resolveBrowserCommand();
const sessions = new Set();

function runCli(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [command, ...args], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const append = (current, chunk) => {
      const next = current + String(chunk);
      if (Buffer.byteLength(next, "utf8") > 2 * 1024 * 1024) {
        child.kill("SIGKILL");
        finish(new Error("agent-browser output exceeded 2 MB"));
      }
      return next;
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", (error) => finish(error));
    child.on("exit", (code, signal) => {
      if (code === 0) finish(null, stdout.trim());
      else finish(new Error(`agent-browser failed (${code ?? signal}):\n${stderr || stdout}`));
    });
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`agent-browser timed out: ${args.slice(2).join(" ")}`));
    }, timeoutMs);
  });
}

async function browser(session, ...args) {
  sessions.add(session);
  return runCli(["--session", session, ...args], 30_000);
}

function expect(ok, message) {
  if (!ok) throw new Error(message);
}

async function closeSession(session) {
  try {
    await runCli(["--session", session, "close"], 10_000);
  } catch {
    // Cleanup is best-effort; the named session also expires in the CLI daemon.
  }
}

async function runPrefillVariant(variant) {
  const portal = await startFakePortal(0);
  const session = `realbud-portal-${variant}-${process.pid}`;
  const wording = `${variant} layout check — approved wording only.`;
  try {
    await browser(session, "open", `${portal.url}/?actor=bud&variant=${variant}`);
    await browser(session, "wait", "--text", "Courtesy reminder");
    await browser(session, "find", "label", "Courtesy reminder", "fill", wording);
    await browser(session, "find", "role", "button", "click", "--name", "Save draft");
    await browser(session, "wait", "--text", "Draft saved. Submit is still yours.");
    expect(portal.state.prefill === wording, `${variant}: browser did not persist the exact wording`);
    expect(portal.prefillCount() === 1, `${variant}: prefill was not exactly once`);
    expect(portal.submitCount() === 0 && portal.state.submitted === null, `${variant}: Bud crossed the Submit boundary`);
  } finally {
    await closeSession(session);
    sessions.delete(session);
    await portal.close();
  }
}

async function runHandoff() {
  const portal = await startFakePortal(0);
  const bud = `realbud-portal-bud-${process.pid}`;
  const human = `realbud-portal-human-${process.pid}`;
  const wording = "Hi Sam — our records still show the rent as outstanding. This is not a formal notice and does not start any notice period.";
  try {
    await browser(bud, "open", `${portal.url}/?actor=bud`);
    await browser(bud, "wait", "--text", "Submit is locked");
    await browser(bud, "snapshot", "-i");
    await browser(bud, "find", "label", "Courtesy reminder", "fill", wording);
    await browser(bud, "find", "role", "button", "click", "--name", "Save draft");
    await browser(bud, "wait", "--text", "Draft saved. Submit is still yours.");
    expect(await browser(bud, "is", "enabled", "#submit-reminder") === "false", "Bud's Submit control was enabled");
    expect(portal.prefillCount() === 1 && portal.submitCount() === 0, "Bud did not stop after one prefill");

    const revoked = await portalRevoke(portal.url);
    expect(revoked.status === 200, "RealBud could not revoke Bud before handoff");
    await browser(bud, "reload");
    await browser(bud, "wait", "--text", "Bud can no longer edit or Submit");
    await browser(bud, "snapshot", "-i");
    expect(await browser(bud, "is", "enabled", "#save-draft") === "false", "Bud could still edit after revocation");
    expect(await browser(bud, "is", "enabled", "#submit-reminder") === "false", "Bud could Submit after revocation");

    await browser(human, "open", `${portal.url}/?actor=human`);
    await browser(human, "wait", "--text", "review before Submit");
    await browser(human, "snapshot", "-i");
    expect(await browser(human, "get", "value", "#courtesy-body") === wording, "PM did not receive the exact approved prefill");
    await browser(human, "find", "role", "button", "click", "--name", "Submit reminder");
    await browser(human, "wait", "--text", "Reminder queued by the portal.");
    expect(portal.submitCount() === 1 && portal.state.submitted === wording, "PM Submit did not occur exactly once");
    const duplicate = await fetch(`${portal.url}/submit`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-realbud-actor": "human" },
      body: JSON.stringify({ body: wording }),
    });
    expect(duplicate.status === 409 && portal.submitCount() === 1, "duplicate PM Submit was not refused");
  } finally {
    for (const session of [bud, human]) {
      await closeSession(session);
      sessions.delete(session);
    }
    await portal.close();
  }
}

try {
  await runHandoff();
  await runPrefillVariant("reordered");
  await runPrefillVariant("delayed");
  console.log("portal browser walkthrough: ALL GREEN");
} finally {
  for (const session of sessions) await closeSession(session);
}
