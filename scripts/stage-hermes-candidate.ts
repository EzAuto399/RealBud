/**
 * Stage the Hermes 0.21.3 candidate runtime, without promoting it.
 *
 * This is step 1 of the promotion procedure recorded in
 * docs/HERMES-0.21.3-EVIDENCE.md. It exists because `startRuntimeUpdate` was
 * once hardcoded to HERMES_RECOMMENDED, which made the procedure circular: the
 * smoke test had to run before promotion, but staging required promotion first.
 *
 * Trusted release-engineer tooling. Deliberately NOT an HTTP route: an HTTP
 * caller must never be able to choose which worker gets installed.
 *
 * What it does: downloads and stages the tag-exact build into a fresh candidate
 * directory under ~/.realbud/hermes/runtimes and makes it the selected runtime.
 * It does NOT change HERMES_RECOMMENDED_VERSION — that is step 3, after the
 * smoke test passes.
 *
 * Reversible: `restorePreviousRuntime()` (or the You window) returns to the
 * previous selection, which stays on disk.
 */
import { runtimeUpdateStatus, startRuntimeUpdate } from '../server/hermes-update.ts';
import { readRuntimeSelection } from '../server/hermes-runtime-selection.ts';
import { HERMES_RELEASES } from '../server/hermes-releases.ts';
import { hermesHome } from '../server/hermes-paths.ts';

const TARGET = '0.21.3';

const release = HERMES_RELEASES.find((entry) => entry.product === TARGET);
if (!release) throw new Error(`Hermes ${TARGET} is not in the install catalog. Admit it there first.`);

console.log(`Staging Hermes ${release.product} (${release.tag}, ${release.commit.slice(0, 12)})`);
console.log('This downloads a ~1.6 GB private runtime. Nothing is promoted by this step.\n');

const job = startRuntimeUpdate({ release });
console.log(`install job started: ${JSON.stringify(job)}`);

const deadline = Date.now() + 45 * 60_000;
let last = '';
while (Date.now() < deadline) {
  const status = runtimeUpdateStatus();
  const line = JSON.stringify(status);
  if (line !== last) {
    console.log(`[status] ${line}`);
    last = line;
  }
  // The job is done when it is no longer running; the selection file is the
  // authority on what was actually adopted.
  const state = status as { running?: boolean; state?: string; phase?: string };
  if (state.running === false || state.state === 'done' || state.state === 'failed') break;
  await new Promise((resolve) => setTimeout(resolve, 3000));
}

const selection = readRuntimeSelection(hermesHome());
console.log(`\nselection: ${JSON.stringify(selection)}`);
const staged = selection.selected?.startsWith(release.commit.slice(0, 40)) ?? false;
console.log(staged
  ? `\nSTAGED. Next: pnpm qa:acp-smoke "${release.product}=<path-to-staged hermes> --profile property"`
  : '\nNOT staged — the selected runtime is unchanged. Read the status above.');
process.exitCode = staged ? 0 : 1;
