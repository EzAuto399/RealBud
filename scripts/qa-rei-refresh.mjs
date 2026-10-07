// REI morning refresh QA (P5 of docs/REI-SOURCE-OF-TRUTH-PLAN-2026-10-06.md): daily use and edge
// cases of the read-only refresh loop. Each case forks scripts/resilience/rei-refresh-child.mjs on a
// fresh temp data folder: the real LoopManager, Desk, BrowserRuntime, broker and recipe runner,
// against the FICTIONAL REI portal. Never REI Cloud, never ~/.realbud, no network, no credentials.
// Writes receipt.json (proof layer + limits) to a new directory; earlier evidence is never overwritten.
//
//   ~/.nvm/versions/node/v24.21.0/bin/node scripts/qa-rei-refresh.mjs [--out DIR]
import { fork } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const date = new Date().toISOString().slice(0, 10);
const out = resolve(args.includes("--out") ? args[args.indexOf("--out") + 1] : join(ROOT, "outputs", `rei-refresh-${date}`));
if (existsSync(join(out, "receipt.json"))) throw new Error(`${out}/receipt.json exists; earlier evidence is never overwritten. Pass --out.`);
if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Run with Node 24 (~/.nvm/versions/node/v24.21.0/bin/node).");
const temp = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "realbud-qa-rei-refresh-")));
const live = resolve(homedir(), ".realbud");
if (temp === live || temp.startsWith(`${live}/`)) throw new Error("Refusing a temp folder inside ~/.realbud.");

const H = 3_600_000;
const T0 = Date.parse("2026-10-05T21:00:00Z"); // Tue 6 Oct, 07:00 Brisbane
const cases = [];
const children = [];

async function child(name, now = T0) {
  const data = join(temp, name); mkdirSync(data, { recursive: true });
  const proc = fork(join(ROOT, "scripts", "resilience", "rei-refresh-child.mjs"), [], { stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: join(temp, `${name}-home`), REALBUD_DATA_DIR: data, REI_CHILD_NOW: String(now) } });
  let log = ""; for (const s of [proc.stdout, proc.stderr]) s.on("data", (b) => { log = (log + b).slice(-8000); });
  children.push(proc);
  const closed = new Promise((r) => proc.once("close", r));
  await Promise.race([new Promise((r) => proc.once("message", r)), closed.then(() => { throw new Error(`child exited: ${log}`); })]);
  const ask = (msg, ms = 60_000) => new Promise((ok, no) => {
    const timer = setTimeout(() => no(new Error(`child silent on ${msg.op}: ${log.slice(-800)}`)), ms);
    proc.once("message", (v) => { clearTimeout(timer); v.ok ? ok(v) : no(new Error(v.error)); }); proc.send(msg);
  });
  return { proc, ask, closed, data, kill: async () => { proc.kill("SIGKILL"); await closed; }, close: async () => { await ask({ op: "close" }).catch(() => {}); await closed; } };
}

async function scenario(id, name, fn) {
  const checks = [], observed = {};
  const check = (label, ok, detail = "") => checks.push({ label, ok: Boolean(ok), ...(detail ? { detail: String(detail).slice(0, 400) } : {}) });
  const t = Date.now(); let error;
  try { await fn(check, (o) => Object.assign(observed, o)); } catch (e) { error = String(e?.stack ?? e).split("\n").slice(0, 3).join(" | "); }
  for (const proc of children.splice(0)) if (proc.exitCode === null) proc.kill("SIGKILL");
  const result = error ? "FAIL" : checks.every((c) => c.ok) ? "PASS" : "FAIL";
  cases.push({ id, name, result, ms: Date.now() - t, observed, checks, ...(error ? { error } : {}) });
  console.log(`${result} ${id}. ${name} (${Date.now() - t}ms)`);
  for (const c of checks) console.log(`     ${c.ok ? "ok  " : "FAIL"} ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
  if (error) console.log(`     error: ${error}`);
}
const fresh = (state) => Object.keys(state.stamps).map((id) => id.replace("src-rei-", "")).sort();
const prop = (state, code) => state.properties.find((p) => p.code === code);
const RENT = (cells, rent) => cells.map((cell, i) => (i === 4 ? rent : cell));

try {
  await scenario("1", "Daily use: new REI properties arrive as cards and are approved; REI changes a rent and Desk follows", async (check, observe) => {
    const c = await child("daily");
    const first = await c.ask({ op: "refresh" });
    check("first refresh completes, every part fresh", first.result.status === "completed" && fresh(first.state).join() === "arrears,owners,tenants", first.result.detail);
    check("REI's properties are proposed as cards, never added", first.state.properties.length === 0 && first.state.proposals.length === 9 && first.state.proposals.every((p) => p.origin === "rei"), `${first.state.proposals.length} cards`);
    const approved = await c.ask({ op: "approve-all" });
    check("one click per card adds each property with REI as its source", approved.state.properties.length === 9 && approved.state.proposals.length === 0, `${approved.state.properties.length} properties`);
    const { FICTIONAL_TENANT_LIST } = await import("../server/testing/fictional-rei-portal.ts");
    await c.ask({ op: "portal", set: { tenants: FICTIONAL_TENANT_LIST.map((row) => (row.cells[0] === "FT-BRAVO" ? { ...row, cells: RENT(row.cells, "$575.00 per week") } : row)) } });
    const next = await c.ask({ op: "refresh", now: T0 + 24 * H });
    check("REI's new rent lands on Desk (REI owns the field)", prop(next.state, "FP-02")?.weeklyRentCents === 57_500 && prop(next.state, "FP-02").differs.length === 0, JSON.stringify(prop(next.state, "FP-02")));
    check("arrears rows now match the tenants grid (names agree); amount owing landed", prop(next.state, "FP-02")?.amountOwingCents === 54_000, String(prop(next.state, "FP-02")?.amountOwingCents));
    check("the deliberate arrears spelling mismatch is held, not guessed", next.state.issues.includes("unmatched REI arrears Fictional Juliet"), next.state.issues.join("; "));
    check("nothing pressed, typed into sign-in, or asked", next.state.portal.effects.length === 0 && next.state.portal.helpRequests === 0, JSON.stringify(next.state.portal));
    observe({ firstDetail: first.result.detail, nextDetail: next.result.detail, firstMs: first.result.ms, nextMs: next.result.ms });
    await c.close();
  });

  await scenario("2", "A Desk-edited field is held as Differs from REI, then resolved with Use REI and with Keep Desk", async (check, observe) => {
    const c = await child("differs");
    await c.ask({ op: "refresh" }); await c.ask({ op: "approve-all" });
    await c.ask({ op: "edit", code: "FP-02", facts: { weeklyRentCents: 60_000, ownerName: "Owner Typed In Desk" } });
    const held = await c.ask({ op: "refresh", now: T0 + 24 * H });
    const p = prop(held.state, "FP-02");
    check("both Desk edits stand and are held as Differs from REI", p.weeklyRentCents === 60_000 && p.owner === "Owner Typed In Desk" && p.differs.map((d) => d.field).sort().join() === "ownerName,weeklyRentCents", JSON.stringify(p.differs));
    check("the refresh line says values wait for a pick", /2 Desk values differ from REI and wait for you to pick/.test(held.result.detail), held.result.detail);
    await c.ask({ op: "resolve", code: "FP-02", field: "weeklyRentCents", pick: "desk" });
    const resolved = await c.ask({ op: "resolve", code: "FP-02", field: "ownerName", pick: "rei" });
    const q = prop(resolved.state, "FP-02");
    check("Keep Desk keeps 600/wk; Use REI takes REI's owner", q.weeklyRentCents === 60_000 && q.owner === "Fictional Owner One" && q.differs.length === 0, JSON.stringify(q));
    const again = await c.ask({ op: "refresh", now: T0 + 48 * H });
    check("the same REI value is not raised again after Keep Desk", prop(again.state, "FP-02").differs.length === 0, JSON.stringify(prop(again.state, "FP-02").differs));
    observe({ heldDetail: held.result.detail });
    await c.close();
  });

  await scenario("3", "An inactive or removed tenant", async (check, observe) => {
    const c = await child("removed");
    await c.ask({ op: "refresh" }); await c.ask({ op: "approve-all" });
    const settled = await c.ask({ op: "refresh", now: T0 + 12 * H });
    const { FICTIONAL_TENANT_LIST } = await import("../server/testing/fictional-rei-portal.ts");
    await c.ask({ op: "portal", set: { tenants: FICTIONAL_TENANT_LIST.filter((row) => row.cells[0] !== "FT-ECHO") } });
    const before = prop(settled.state, "FP-05");
    const after = await c.ask({ op: "refresh", now: T0 + 24 * H });
    const kept = prop(after.state, "FP-05");
    check("a tenant REI no longer lists: Desk keeps the property and its last values (nothing deleted)", after.state.properties.length === settled.state.properties.length &&
      ["tenantName", "weeklyRentCents", "amountOwingCents", "owner"].every((key) => JSON.stringify(kept?.[key]) === JSON.stringify(before[key])) && JSON.stringify(kept?.rei) === JSON.stringify(before.rei), JSON.stringify(kept));
    check("the vacated tenancy sharing FP-04 with its successor is held as ambiguous, not guessed", after.state.issues.includes("ambiguous REI property FP-04"), after.state.issues.join("; "));
    const delta = prop(after.state, "FP-08");
    observe({ inactiveDelta: delta, gap: "Status=All lists Inactive tenancies (REI's grid has no status column), so Delta's FP-08 was proposed and approved like any other; a removed tenant is not flagged on Desk." });
    check("the inactive tenancy is read like any other row (Status All); nothing in REI changed", after.state.portal.effects.length === 0, `FP-08 on Desk: ${Boolean(delta)}`);
    await c.close();
  });

  await scenario("4", "Session expires mid-run: partial, then stale per part; next run after sign-in completes", async (check, observe) => {
    const c = await child("expiry");
    await c.ask({ op: "portal", set: { signOutAfterSteps: 4 } });
    const partial = await c.ask({ op: "refresh" });
    check("partial, with tenants fresh and arrears/owners stale", partial.result.status === "partial" && fresh(partial.state).join() === "tenants", `${partial.result.status}: ${partial.result.detail}`);
    check("it says Missed: sign in to REI for the rest, and never asked for help or typed a password", /Missed: sign in to REI/.test(partial.result.detail) && partial.state.portal.helpRequests === 0, partial.result.detail);
    await c.close();
    const d = await child("expiry-out");
    await d.ask({ op: "sign-out" });
    const missed = await d.ask({ op: "refresh" });
    check("signed out from the start: Missed: sign in to REI, Desk stamps untouched", missed.result.status === "missed" && missed.result.detail.startsWith("Missed: sign in to REI.") && fresh(missed.state).length === 0, missed.result.detail);
    observe({ partial: partial.result.detail, missed: missed.result.detail });
    await d.close();
  });

  await scenario("5", "REI slow, then down: timeout and failure leave Desk as it was; the next run recovers", async (check, observe) => {
    const c = await child("slow");
    const good = await c.ask({ op: "refresh" });
    const stamps = good.state.stamps;
    // Slow enough that the tenants list is read before the timeout ends the run part-way.
    await c.ask({ op: "portal", set: { delayMs: 10 } }); await c.ask({ op: "timeout", ms: 3000 });
    const slow = await c.ask({ op: "refresh", now: T0 + 24 * H });
    check("slow REI: the refresh stops at its timeout and says so", /didn't answer in time/.test(slow.result.detail) && slow.result.status === "missed", `${slow.result.status} in ${slow.result.ms}ms: ${slow.result.detail}`);
    check("every part keeps the stamp it had before the slow run (nothing from the cut-off read applied)",
      ["src-rei-tenants", "src-rei-arrears", "src-rei-owners"].every((id) => stamps[id] !== undefined && slow.state.stamps[id] === stamps[id]), JSON.stringify({ before: stamps, after: slow.state.stamps, observes: slow.state.portal.observes }));
    await c.ask({ op: "portal", set: { delayMs: null, down: true } }); await c.ask({ op: "timeout", ms: 0 });
    const down = await c.ask({ op: "refresh", now: T0 + 25 * H });
    check("REI down: failed with a plain reason, Desk stamps unchanged", down.result.status === "failed" && JSON.stringify(down.state.stamps) === JSON.stringify(slow.state.stamps), down.result.detail);
    await c.ask({ op: "portal", set: { down: null } });
    const back = await c.ask({ op: "refresh", now: T0 + 26 * H });
    check("REI back: the next run completes and every part is fresh again", back.result.status === "completed" && Object.values(back.state.stamps).every((at) => at === T0 + 26 * H), back.result.detail);
    observe({ slowMs: slow.result.ms, slow: slow.result.detail, down: down.result.detail });
    await c.close();
  });

  await scenario("6", "Two refreshes racing: one reads, the other does not start, Desk changes once", async (check, observe) => {
    const c = await child("race");
    await c.ask({ op: "portal", set: { delayMs: 2 } });
    const race = await c.ask({ op: "race" });
    const statuses = race.result.map((r) => r.status).sort();
    check("one completed, one did not start", statuses.join() === "completed,missed" && race.result.some((r) => /already running/.test(r.detail)), JSON.stringify(race.result.map((r) => r.detail)));
    check("one borrow of the REI tab; cards not duplicated", race.state.portal.borrows === 1 && race.state.proposals.length === 9, `${race.state.portal.borrows} borrows, ${race.state.proposals.length} cards`);
    await c.ask({ op: "enable" });
    await c.ask({ op: "run" });
    const twice = await c.ask({ op: "run" }).then(() => "accepted", (e) => e.message);
    check("the clock refuses a second run of the same loop while one runs", /already running/.test(twice), twice);
    await c.ask({ op: "settle" });
    observe({ race: race.result.map((r) => `${r.status}: ${r.detail.slice(0, 120)}`) });
    await c.close();
  });

  await scenario("7", "App restart mid-refresh (SIGKILL): clean miss, no half-applied Desk; the next run reads cleanly", async (check, observe) => {
    const c = await child("restart");
    await c.ask({ op: "portal", set: { delayMs: 15 } });
    await c.ask({ op: "enable" });
    const started = await c.ask({ op: "run" });
    await c.ask({ op: "wait-observes", n: 8 });
    await c.kill();
    const d = await child("restart"); // same data folder, a new process
    const after = await d.ask({ op: "state" });
    const run = after.state.runs.find((r) => r.id === started.result.id);
    check("the killed run reads Interrupted on restart (a clean miss, not resumed mid-action)", run?.status === "interrupted", JSON.stringify(run));
    check("Desk has nothing from the killed read: no REI stamps, no cards, no REI facts", fresh(after.state).length === 0 && after.state.proposals.length === 0 && after.state.properties.length === 0, JSON.stringify({ stamps: after.state.stamps, cards: after.state.proposals.length }));
    // The killed process left its browser session lease: the next refresh fails plainly until the person releases it.
    const held = await d.ask({ op: "refresh", now: T0 + H });
    check("before the person releases the earlier browser session, the refresh fails plainly and applies nothing", held.result.status === "failed" && fresh(held.state).length === 0, held.result.detail);
    await d.ask({ op: "release" });
    const next = await d.ask({ op: "refresh", now: T0 + 2 * H });
    check("after release, the next run completes and stamps every part", next.result.status === "completed" && fresh(next.state).join() === "arrears,owners,tenants", next.result.detail);
    observe({ interrupted: run?.detail, startupAfterKill: after.state.startup, beforeRelease: held.result.detail });
    await d.close();
  });

  await scenario("8", "Clock jump: back and forward a day never runs one slot twice", async (check, observe) => {
    const t0 = Date.parse("2026-10-05T06:00:00Z"); // Monday 06:00 UTC (the child's clock is UTC); the loop runs weekdays 07:00
    const c = await child("clock", t0);
    await c.ask({ op: "tick", now: t0 }); await c.ask({ op: "enable", now: t0 });
    const counts = [];
    for (const [label, at] of [["Mon 07:30", t0 + 1.5 * H], ["-24h", t0 - 22.5 * H], ["Mon 07:30 again", t0 + 1.5 * H], ["+24h Tue 07:30", t0 + 25.5 * H], ["Tue again", t0 + 25.5 * H]]) {
      const st = await c.ask({ op: "tick", now: at }); await c.ask({ op: "settle" });
      counts.push({ label, executed: st.state.executed.length });
    }
    const end = (await c.ask({ op: "state" })).state;
    check("one run per slot: Monday and Tuesday once each", end.executed.length === 2 && new Set(end.executed).size === 2, JSON.stringify(counts));
    observe({ counts, runs: end.runs.map((r) => `${new Date(r.scheduledFor).toISOString().slice(0, 16)} ${r.status}`) });
    await c.close();
  });

  await scenario("9", "Duplicate tenant names and ambiguous rows are held, never guessed", async (check, observe) => {
    const c = await child("dupes");
    await c.ask({ op: "add", property: { address: "6 Fictional St", tenantName: "Fictional Tenant Golf", tenantPhone: "1", weeklyRentCents: 50_000 } });
    await c.ask({ op: "add", property: { address: "16 Fictional St", tenantName: "Fictional Tenant Golf", tenantPhone: "1", weeklyRentCents: 50_000 } });
    const before = (await c.ask({ op: "state" })).state.properties;
    const after = await c.ask({ op: "refresh" });
    check("an arrears name matching two Desk tenants is held as ambiguous", after.state.issues.includes("ambiguous REI arrears Fictional Tenant Golf"), after.state.issues.join("; "));
    check("REI's two tenancies on FP-04 are held as ambiguous", after.state.issues.includes("ambiguous REI property FP-04"));
    check("neither duplicate changed", before.every((p) => JSON.stringify(after.state.properties.find((q) => q.id === p.id)) === JSON.stringify(p)), "");
    observe({ issues: after.state.issues });
    await c.close();
  });

  await scenario("10", "An empty REI account", async (check, observe) => {
    const c = await child("empty");
    await c.ask({ op: "add", property: { address: "1 Kept St", tenantName: "Fictional Kept", tenantPhone: "1", weeklyRentCents: 40_000 } });
    await c.ask({ op: "portal", set: { tenants: [], arrears: [], owners: [] } });
    const r = await c.ask({ op: "refresh" });
    check("completes, every part read (empty) and fresh", r.result.status === "completed" && fresh(r.state).join() === "arrears,owners,tenants", r.result.detail);
    check("nothing on Desk is removed or changed; no cards or holds", r.state.properties.length === 1 && r.state.properties[0].rei === null && r.state.proposals.length === 0 && r.state.issues.length === 0, JSON.stringify(r.state.properties));
    observe({ detail: r.result.detail });
    await c.close();
  });

  await scenario("11", "A large book (300 properties): time and memory", async (check, observe) => {
    const c = await child("book300");
    await c.ask({ op: "book", count: 300 });
    const base = (await c.ask({ op: "state" })).state.memory;
    // find-record has no paginate step: an owners list longer than one page (5 rows here) is never read whole.
    const paged = await c.ask({ op: "refresh", now: T0 - H }, 300_000);
    check("an owners list past one page is partial and says owners were not read whole", paged.result.status === "partial" && /Not read whole this run[^.]*owners/.test(paged.result.detail), paged.result.detail);
    await c.ask({ op: "portal", set: { pageSize: 50 } });
    const first = await c.ask({ op: "refresh" }, 300_000);
    const approve = await c.ask({ op: "approve-all" }, 300_000);
    const second = await c.ask({ op: "refresh", now: T0 + 24 * H }, 300_000);
    const mb = (bytes) => Math.round(bytes / 1048576);
    check("first read: 300 cards, every part fresh", first.result.status === "completed" && first.state.proposals.length === 300, `${first.result.status} ${first.state.proposals.length} cards in ${first.result.ms}ms`);
    check("after approval, the next read updates all 300 in place", second.result.status === "completed" && second.state.properties.length === 300 && /300 properties updated|0 properties updated|Every part is fresh/.test(second.result.detail), `${second.result.detail} in ${second.result.ms}ms`);
    // The live helper caps an observation at about 6000 tokens: a 300-row scrolling Tenants grid comes back cut.
    await c.ask({ op: "portal", set: { observeChars: 24_000 } });
    const cut = await c.ask({ op: "refresh", now: T0 + 48 * H }, 300_000);
    check("a page cut by the helper's cap is partial: tenants not re-stamped, and the run says it was not read whole", cut.result.status === "partial" &&
      /Not read whole this run[^.]*tenants/.test(cut.result.detail) && cut.state.stamps["src-rei-tenants"] !== T0 + 48 * H, `${cut.result.status}: ${cut.result.detail}`);
    observe({ firstReadMs: first.result.ms, approve300Ms: approve.result.ms, secondReadMs: second.result.ms, cappedReadMs: cut.result.ms, cappedDetail: cut.result.detail,
      rssMB: { before: mb(base.rss), afterFirst: mb(first.state.memory.rss), afterSecond: mb(second.state.memory.rss) }, heapUsedMB: { before: mb(base.heapUsed), afterFirst: mb(first.state.memory.heapUsed), afterSecond: mb(second.state.memory.heapUsed) },
      observes: second.state.portal.observes, scrolls: second.state.portal.scrolls });
    await c.close();
  });

  await scenario("12", "A live-shaped tenants grid (90 rows first, more as it scrolls): 106 rows read whole; a grid that stops loading is partial", async (check, observe) => {
    const c = await child("grid106");
    await c.ask({ op: "book", count: 106 }); await c.ask({ op: "portal", set: { pageSize: 50 } });
    const whole = await c.ask({ op: "refresh" });
    check("106 rows read whole after scrolling the grid's own content, every part fresh", whole.result.status === "completed" && whole.state.proposals.length === 106 && whole.state.portal.scrolls >= 1,
      `${whole.result.status}, ${whole.state.proposals.length} cards, ${whole.state.portal.scrolls} scrolls: ${whole.result.detail}`);
    await c.close();
    const d = await child("grid-stalls");
    await d.ask({ op: "book", count: 106 }); await d.ask({ op: "portal", set: { pageSize: 50, gridStallsAt: 95 } });
    const stalled = await d.ask({ op: "refresh" });
    check("a grid that stops loading at 95 of 106 is partial: tenants never stamped, no cards", stalled.result.status === "partial" &&
      /Not read whole this run[^.]*tenants/.test(stalled.result.detail) && !stalled.state.stamps["src-rei-tenants"] && stalled.state.proposals.length === 0,
      `${stalled.result.status}, ${stalled.state.portal.scrolls} scrolls: ${stalled.result.detail}`);
    check("nothing pressed in REI while reading and scrolling", whole.state.portal.effects.length === 0 && stalled.state.portal.effects.length === 0);
    observe({ wholeMs: whole.result.ms, stalledMs: stalled.result.ms, wholeScrolls: whole.state.portal.scrolls, stalledScrolls: stalled.state.portal.scrolls });
    await d.close();
  });
} finally {
  for (const proc of children.splice(0)) if (proc.exitCode === null) proc.kill("SIGKILL");
  rmSync(temp, { recursive: true, force: true });
  const head = await import("node:child_process").then(({ execFileSync }) => { try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(); } catch { return null; } });
  const receipt = {
    at: new Date().toISOString(), label: "fictional-rei-morning-refresh", proofLayer: "local tests — source modules (LoopManager, Desk, BrowserRuntime, broker, recipe runner) in child processes against the fictional REI portal",
    source: { head, node: process.version }, command: "node scripts/qa-rei-refresh.mjs",
    summary: Object.fromEntries(["PASS", "FAIL"].map((k) => [k, cases.filter((c) => c.result === k).map((c) => c.id)])),
    cases,
    limits: [
      "Fictional REI portal and data only: no REI Cloud, customer account, credential or network. Its columns and behaviour are shaped after a read-only look at live REI, not proven against it.",
      "No HTTP service, renderer, packaged build or installed device here: the loop's service wiring (server/index.ts) is exercised by qa-austin-day-one step 8, API only.",
      "The person's side (card approval, Desk edits, picks) is simulated by the script.",
      "Timings are on this Mac with no browser; live REI page loads and the helper's observation cap dominate real runs.",
      "Freshness keeps P2/P3's 24-hour window: a missed morning leaves the previous read fresh until it is 24 hours old.",
      "The grid scroll is main's browser_read all_rows (the pack-declared grid container only); the fictional grid mirrors live REI's 90-row render, not proven against live REI by this script.",
    ],
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`receipt ${join(out, "receipt.json")}`);
  console.log(`summary ${JSON.stringify(receipt.summary)}`);
  if (cases.some((c) => c.result !== "PASS")) process.exitCode = 1;
}
