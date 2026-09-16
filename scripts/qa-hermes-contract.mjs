#!/usr/bin/env node
// Real provider canary using synthetic text only. No portal, mail, PMS writes,
// installer, or edits to the independent Hermes runtime/profile. Exit nonzero
// on a held/failed model turn; a guard-only run is not a passing live canary.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const packaged = process.argv.includes("--packaged");
const appArgument = process.argv.indexOf("--app");
if (appArgument !== -1 && (!packaged || !process.argv[appArgument + 1] || process.argv[appArgument + 1].startsWith("--"))) {
  throw new Error("Use --packaged --app /absolute/path/to/RealBud.app to select a build.");
}
const appPath = appArgument === -1
  ? join(dirname(fileURLToPath(import.meta.url)), "../release/mac-arm64/RealBud.app")
  : resolve(process.argv[appArgument + 1]);
const resources = join(appPath, "Contents/Resources");
const runtimeModule = name => import(packaged
  ? pathToFileURL(join(resources, "server", `${name}.js`)).href
  : new URL(`../server/${name}.ts`, import.meta.url).href);
const scratch = mkdtempSync(join(tmpdir(), "realbud-hermes-contract-"));
// Resolve the explicitly existing worker before isolating application records.
// Otherwise REALBUD_DATA_DIR selects a new, unconfigured Hermes home and the
// canary fails its setup check despite the installed profile being ready.
process.env.REALBUD_HERMES_HOME = (await runtimeModule("hermes-paths")).hermesHome();
process.env.REALBUD_DATA_DIR = scratch;
let instance;
let recorder;
try {
  console.log(`qa-hermes-contract: checking ${packaged ? "packaged" : "source"} runtime with ${process.versions.electron ? "Electron" : "Node"} ${process.versions.electron || process.versions.node}`);
  const { ensureDirs } = await runtimeModule("config"); ensureDirs();
  const { hermesStatus, applyHandsReadiness } = await runtimeModule("hermes-status");
  const { tryHermesPing } = await runtimeModule("hermes-hands");
  const { shapeRecipeDraft } = await runtimeModule("recipe-draft");
  const { saveRecipe, getRecipe, patchRecipe } = await runtimeModule("recipes");
  const { executeRecipeJob } = await runtimeModule("job-executor");
  const { JobRunStore } = await runtimeModule("job-runs");
  const { HermesAgentDriver } = await runtimeModule("drivers/acp/hermes");
  // Recorder is test instrumentation only; every production module above is
  // loaded from the selected build, including the ACP driver and job store.
  const { recordEvents } = await import("../server/testing/events.ts");
  const status = await hermesStatus();
  assert.equal(status.cli.compatible, true, "installed release must be supported");
  assert.equal(status.pack.workroomReady, true, "private workroom must be ready");
  const ping = await tryHermesPing();
  assert.equal(ping.ok, true, "real provider must answer OK");
  assert.equal(applyHandsReadiness(await hermesStatus(), { ...ping, kind: "ping", at: Date.now() }).ready, true);
  console.log(`PASS real provider ping (${ping.elapsedMs}ms), current readiness proof`);

  const shaped = await shapeRecipeDraft("Teach a model-only rehearsal job: using only the fictional numbers supplied here, 17 and 26, add them and prepare a one-line internal summary with the total. Do not read files or websites, communicate externally or change records. Run on demand. Abilities: analyse and draft only. Done when the output contains the sum and cites the two supplied numbers.");
  assert.ok(shaped.draft, `real worker must shape a valid editable plan: ${shaped.detail}`);
  // Bound the agreed rehearsal to the synthetic inputs even if the model
  // proposes broader capabilities. The PM owns this edit and approval.
  const recipe = { ...shaped.draft, id: "synthetic-canary", title: "Synthetic total rehearsal", description: "Fictional inputs: 17 and 26. Prepare their sum in a one-line internal summary.", steps: ["Add the supplied fictional numbers 17 and 26.", "Prepare the total and cite both inputs. Do not use tools, files or websites."], allowedOrigins: [], capabilities: ["analyse", "draft"], limits: { maxRuntimeMinutes: 2, maxTurns: 3 }, evidence: "The prepared output includes the correct sum and both supplied fictional numbers.", schedule: null, status: "shadow" };
  saveRecipe(recipe);
  let saved = getRecipe(recipe.id);
  assert.ok(saved && !saved.planApprovedAt);
  const file = join(scratch, "contract-runs.json");
  const runStore = new JobRunStore({ file });
  const rehearsal = await executeRecipeJob(saved, { mode: "shadow", trigger: "manual", idempotencyKey: "canary-rehearsal" }, { store: runStore });
  assert.equal(rehearsal.run.status, "completed", "real rehearsal must complete");
  patchRecipe(saved.id, { expectedRevision: saved.revision, planApproved: true });
  saved = getRecipe(saved.id);
  assert.equal(saved.approvedRevision, saved.revision, "approval must bind the edited revision");
  const input = { mode: "prepare", trigger: "manual", idempotencyKey: "canary-prepare" };
  const result = await executeRecipeJob(saved, input, { store: runStore });
  assert.equal(result.run.status, "completed", "real preparation must complete");
  assert.match(JSON.stringify(result.run.evidence), /\b43\b/, "receipt must contain the computed total");
  const again = await executeRecipeJob(saved, input, { store: runStore });
  assert.equal(again.reused, true); assert.equal(again.run.id, result.run.id);
  const reopened = new JobRunStore({ file });
  assert.equal(reopened.list(saved.id).find(r => r.id === result.run.id)?.status, "completed");
  console.log("PASS real plan drafting, rehearsal, exact approval, computed receipt, duplicate prevention and receipt reload");

  // Real file tools and a realistic PM output, with facts supplied only in
  // the fictional documents. The random reference proves the model read them.
  const { seedVault } = await runtimeModule("vault");
  const workroom = seedVault();
  const quoteReference = `TRAINING-${randomUUID().slice(0, 8)}`;
  writeFileSync(join(workroom, "quote-a.md"), `Fictional maintenance quote. Reference: ${quoteReference}.\nAcacia Plumbing: replace the leaking kitchen tap and remove the old fitting.\nTotal AUD 1,375. Warranty: not stated. Access date: not confirmed.\n`, {mode: 0o600});
  writeFileSync(join(workroom, "quote-b.md"), `Fictional maintenance quote. Reference: ${quoteReference}.\nBanksia Plumbing: replace the leaking kitchen tap and remove the old fitting.\nTotal AUD 1,485. Warranty: 12 months. Access date: not confirmed.\n`, {mode: 0o600});
  const comparison = {
    ...saved, id: "synthetic-quote-comparison", title: "Training maintenance comparison",
    description: "Read quote-a.md and quote-b.md in the current workroom. Prepare a comparison and an owner update for review, using only those fictional documents.",
    steps: ["Read both named quote files and record their reference, scope, quoted totals, warranty and access details.", "Calculate the difference between quoted totals and identify what remains unconfirmed.", "Prepare a complete comparison and a usable owner update with sources and questions to resolve. Do not choose a contractor, contact anyone or change files."],
    capabilities: ["read-files", "analyse", "draft"], limits: {maxRuntimeMinutes: 2, maxTurns: 6},
    evidence: "Complete comparison and owner update, both source filenames, their exact shared reference, the two quoted totals, their difference and missing information.",
  };
  const compared = await executeRecipeJob(comparison, {mode: "prepare", trigger: "manual", idempotencyKey: "canary-quotes"}, {store: runStore});
  assert.ok(["completed", "awaiting-approval"].includes(compared.run.status), "real file comparison must produce useful work");
  const fullOutput = compared.run.evidence.filter(item => item.kind === "output").map(item => item.note).join("\n\n");
  const allEvidence = JSON.stringify(compared.run.evidence);
  assert.match(allEvidence, /1,?375/); assert.match(allEvidence, /1,?485/); assert.match(allEvidence, /\b110\b/);
  assert.ok(allEvidence.includes(quoteReference), "receipt must contain the unpredictable reference from the files");
  assert.match(allEvidence, /quote-a\.md/); assert.match(allEvidence, /quote-b\.md/);
  assert.ok(fullOutput.length > 500, "useful PM output must survive beyond the former 500-character cap");
  const restoredComparison = new JobRunStore({file}).get(compared.run.id);
  assert.equal(restoredComparison.evidence.filter(item => item.kind === "output").map(item => item.note).join("\n\n"), fullOutput);
  console.log(`PASS real file reading, source reference, quote arithmetic, complete PM output (${fullOutput.length} characters) and durable reload`);

  const create = async () => {
    instance = await HermesAgentDriver.create({ instanceId: "synthetic-contract", displayName: "Synthetic contract", enabled: true, environment: {}, config: HermesAgentDriver.defaultConfig() });
    recorder = recordEvents(instance.adapter);
  };
  const turn = async (text, transcript) => {
    const { turnId } = await instance.adapter.sendTurn({ threadId: "synthetic-contract", text, model: "default", ...(transcript ? { transcript } : {}) });
    const done = await recorder.until(e => e.type === "turn.completed" && e.turnId === turnId, 120_000);
    assert.equal(done.ok, true, "real ACP turn must complete");
    return recorder.events.filter(e => e.turnId === turnId && e.type === "item.completed" && e.itemType === "assistant_text").map(e => e.text).join("\n");
  };
  await create();
  const first = "Remember the synthetic rehearsal label acacia-43 for this conversation. Reply exactly READY. Do not use tools.";
  assert.match(await turn(first), /READY/);
  assert.match(await turn("What is the rehearsal label? Reply with only the label. Do not use tools."), /acacia-43/);
  recorder.stop(); await instance.dispose(); instance = null;
  await create();
  assert.match(await turn("What is the rehearsal label? Reply with only the label. Do not use tools.", [{ role: "user", text: first }, { role: "assistant", text: "READY" }]), /acacia-43/);
  console.log("PASS real ACP handshake, warm follow-up and fresh-process transcript recovery");
  console.log("qa-hermes-contract: PASSED with synthetic inputs; no real-office or customer proof claimed");
} catch (error) {
  console.error(`qa-hermes-contract: FAILED: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
} finally {
  recorder?.stop(); await instance?.dispose();
  rmSync(scratch, { recursive: true, force: true });
}
