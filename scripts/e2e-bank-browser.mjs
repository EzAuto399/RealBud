#!/usr/bin/env node
// Visible read-only bank observation proof. This is a local QA fixture, not a
// production bank connector: an isolated browser signs into the fake account,
// reads the bounded credit list, and feeds a typed digest-bound batch through
// the durable work broker into Desk. Money controls remain unreachable.
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { bankTransactionDigest } from "../server/bank-observation.ts";
import { runBankObservationImport } from "../server/bank-work-reconciler.ts";
import { Desk } from "../server/desk.ts";
import { FAKE_BANK_LOGIN, startFakeBankPortal } from "../server/testing/fake-bank-portal.ts";
import { WorkBroker } from "../server/work-broker.ts";

const AGENT_BROWSER_PACKAGE = "agent-browser@0.27.0";
const digest = (value) => createHash("sha256").update(value).digest("hex");

function resolveBrowserCommand() {
  const explicit = process.env.AGENT_BROWSER_BIN?.trim();
  if (explicit) return explicit;
  const local = fileURLToPath(new URL("../node_modules/agent-browser/bin/agent-browser.js", import.meta.url));
  if (existsSync(local)) return local;
  const probe = spawnSync("npm", [
    "exec", "--yes", `--package=${AGENT_BROWSER_PACKAGE}`, "--", "node", "-e",
    "const fs=require('fs'),p=require('path');for(const d of process.env.PATH.split(p.delimiter)){const f=p.join(d,'agent-browser');if(fs.existsSync(f)){process.stdout.write(f);break}}",
  ], { encoding: "utf8", timeout: 30_000 });
  if (probe.error) throw probe.error;
  const resolved = probe.stdout.trim();
  if (probe.status !== 0 || !resolved) throw new Error(`agent-browser is unavailable: ${probe.stderr || "CLI not found"}`);
  return resolved;
}

const command = resolveBrowserCommand();
const session = `realbud-bank-readonly-${process.pid}`;

function runCli(args, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [command, ...args], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`agent-browser timed out: ${args.slice(2).join(" ")}`));
    }, timeoutMs);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
  });
}

const browser = (...args) => runCli(["--session", session, ...args]);
const expect = (condition, message) => { if (!condition) throw new Error(message); };

async function closeBrowser() {
  try { await runCli(["--session", session, "close"], 10_000); } catch { /* best effort */ }
}

const now = new Date(2026, 7, 27, 9, 30, 0).getTime();
const dir = mkdtempSync(join(tmpdir(), "realbud-bank-browser-"));
const portal = await startFakeBankPortal({ now });

try {
  await browser("open", `${portal.url}/login`);
  await browser("wait", "--text", "Sign in to view account activity");
  await browser("find", "label", "Customer ID", "fill", FAKE_BANK_LOGIN.username);
  await browser("find", "label", "Password", "fill", FAKE_BANK_LOGIN.password);
  await browser("find", "role", "button", "click", "--name", "Sign in");
  await browser("wait", "--text", "Account activity");
  await browser("snapshot", "-i");
  expect(await browser("is", "enabled", "#transfer-money") === "false", "transfer control became available to Bud");
  expect(await browser("is", "enabled", "#add-payee") === "false", "payee control became available to Bud");

  const text = await browser("get", "text", "#credit-list");
  const accountFingerprint = digest(portal.maskedAccount);
  const credits = text.split(/\r?\n/).filter(Boolean).map((line) => {
    const [bookedIso, amount, ...referenceParts] = line.split("|");
    const reference = referenceParts.join("|");
    const bookedAt = Date.parse(bookedIso);
    const amountCents = Number(amount);
    expect(Number.isFinite(bookedAt) && Number.isInteger(amountCents) && reference, "browser returned malformed credit data");
    const credit = {
      bookedAt,
      amountCents,
      reference,
    };
    return { ...credit, transactionDigest: bankTransactionDigest(accountFingerprint, credit) };
  });
  expect(credits.length === portal.credits.length, "browser did not read the bounded credit list completely");

  const desk = new Desk({ file: join(dir, "desk.json"), now: () => now });
  desk.importCsv([
    "propertyCode,daysSinceDue,rentLanded,levyPaid",
    "prop-oak,4,false,false",
  ].join("\n"), now, desk.revision);
  const broker = new WorkBroker({ file: join(dir, "work-broker.json"), now: () => now });
  const expectedRevision = desk.revision;
  const result = runBankObservationImport({
    broker,
    desk,
    requestId: `bank-check-${digest(`${expectedRevision}:${now}:${portal.url}`).slice(0, 32)}`,
    expectedRevision,
    allowedOrigins: [portal.url],
    batch: {
      kind: "realbud.bank-credit-observation.v1",
      schemaVersion: 1,
      accountFingerprint,
      observedAt: now,
      credits,
    },
    now: () => now,
  });
  expect(result.receipt.state === "reconciled", "bank work receipt did not reconcile");
  expect(result.snapshot.results.find((row) => row.propertyId === "prop-oak")?.reason === "conflicted-source", "bank/PMS discrepancy did not hold Oak wording");
  expect(result.snapshot.book.importIssues.some((issue) => issue.rawIdentity.startsWith("Bank credit ")), "unmatched credit did not reach Desk");
  expect(JSON.stringify(result.snapshot).includes("UNMATCHED FIXTURE CREDIT") === false, "raw bank reference leaked into Desk");

  const transfer = await fetch(`${portal.url}/transfer`, { method: "POST" });
  const payee = await fetch(`${portal.url}/payees`, { method: "POST" });
  expect(transfer.status === 403 && payee.status === 403, "fake bank money endpoints were not fail-closed");
  expect(portal.transferAttempts() === 1 && portal.payeeAttempts() === 1, "forbidden endpoint probes were not recorded exactly once");
  console.log("bank browser walkthrough: ALL GREEN");
} finally {
  await closeBrowser();
  await portal.close();
  rmSync(dir, { recursive: true, force: true });
}
