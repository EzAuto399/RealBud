#!/usr/bin/env node
// Trusted operator tooling for the Composio projects that back each office.
// Never expose this through an HTTP route, and never run it from the desk app:
// it holds the organisation key, which can act on every office at once.
//
//   REALBUD_COMPOSIO_ORG_KEY=… node --experimental-strip-types scripts/manage-composio-projects.mjs <command>
//
//   list                                  Projects on this Composio organisation
//   show     --project pr_…               One project
//   provision --name "Harbour PM"         Create a project; prints the ak_ key ONCE
//   rotate   --project pr_… --confirm     New key; every existing key stops at once
//   decommission --project pr_… --confirm --revoke-upstream
//                                         Delete the project AND revoke the office's
//                                         upstream OAuth credentials. Irreversible.
//
// `provision` prints the project key because that is the only time Composio will
// return it. Move it into the office's RealBud setup, then treat this terminal
// as compromised. The key is never written to disk, a log, or this tool's output
// again, and `list` does not print keys.
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  COMPOSIO_PLATFORM_API,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  regenerateProjectKey,
} from "../server/composio-project.ts";

const ORG_KEY_ENV = "REALBUD_COMPOSIO_ORG_KEY";

const HELP = `Trusted RealBud tooling for Composio office projects.

Usage: ${ORG_KEY_ENV}=… node --experimental-strip-types scripts/manage-composio-projects.mjs <command> [options]

Commands:
  list                                        Projects on this Composio organisation
  show     --project pr_…                     One project
  provision --name "<office>"                 Create a project and print its ak_ key once
  rotate   --project pr_… --confirm           Replace the project key (all old keys stop)
  decommission --project pr_… --confirm --revoke-upstream
                                              Delete the project and revoke upstream credentials

Options:
  --project <pr_…>    Composio project id
  --name <text>       Project name, usually the office name
  --confirm           Required for rotate and decommission
  --revoke-upstream   Required for decommission; revokes the office's OAuth grants
  --json              Print machine-readable output
  --help              This text

Decommission is irreversible. It is the only action that revokes the office's
upstream OAuth credentials, so it is what makes "the office left" true rather
than merely hidden.
`;

class UsageError extends Error {}

function parseArgs(argv) {
  const options = { command: "", project: "", name: "", confirm: false, revokeUpstream: false, json: false, help: false };
  const flagFor = { "--project": "project", "--name": "name" };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") { options.help = true; continue; }
    if (arg === "--confirm") { options.confirm = true; continue; }
    if (arg === "--revoke-upstream") { options.revokeUpstream = true; continue; }
    if (arg === "--json") { options.json = true; continue; }
    if (flagFor[arg]) {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`${arg} needs a value.`);
      options[flagFor[arg]] = value;
      continue;
    }
    if (arg.startsWith("-")) throw new UsageError(`Unknown option ${arg}.`);
    if (options.command) throw new UsageError(`Unexpected argument ${arg}.`);
    options.command = arg;
  }
  return options;
}

function requireOrgKey() {
  const key = (process.env[ORG_KEY_ENV] ?? "").trim();
  if (!key) {
    throw new UsageError(
      `${ORG_KEY_ENV} is not set. Export the organisation key (x-org-api-key) from the Composio dashboard. It can act on every office, so use a trusted machine.`,
    );
  }
  return key;
}

function requireProject(options) {
  if (!options.project.trim()) throw new UsageError("--project pr_… is required for this command.");
  return options.project.trim();
}

/** Print a key exactly once, on its own line, so it is easy to move and easy to
 *  notice. Everything else about this tool is deliberately quiet. */
function printKeyOnce(key) {
  process.stdout.write(`Project key (shown once — move it into the office's RealBud setup now):\n${key}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.command) {
    process.stdout.write(HELP);
    return options.command ? 0 : options.help ? 0 : 1;
  }
  if (!["list", "show", "provision", "rotate", "decommission"].includes(options.command)) {
    throw new UsageError(`Unknown command ${options.command}.`);
  }

  const orgKey = requireOrgKey();

  if (options.command === "list") {
    const projects = await listProjects(orgKey);
    if (options.json) process.stdout.write(`${JSON.stringify(projects)}\n`);
    else if (!projects.length) process.stdout.write("No projects on this organisation.\n");
    else for (const project of projects) process.stdout.write(`${project.id}\t${project.name}\n`);
    return 0;
  }

  if (options.command === "show") {
    const project = await getProject(orgKey, requireProject(options));
    if (options.json) process.stdout.write(`${JSON.stringify(project)}\n`);
    else process.stdout.write(`${project.id}\t${project.name}\n`);
    return 0;
  }

  if (options.command === "provision") {
    const name = options.name.trim();
    if (!name) throw new UsageError("--name \"<office>\" is required so the project is identifiable later.");
    const project = await createProject(orgKey, name);
    if (options.json) process.stdout.write(`${JSON.stringify(project)}\n`);
    else {
      process.stdout.write(`Created ${project.id} (${project.name}).\n`);
      if (project.apiKey) printKeyOnce(project.apiKey);
      else process.stdout.write("Composio returned no project key; rotate it before use.\n");
    }
    return 0;
  }

  const projectId = requireProject(options);
  if (!options.confirm) {
    throw new UsageError(
      `${options.command} is not reversible. Re-run with --confirm once you are sure it is the right project (${projectId}).`,
    );
  }

  if (options.command === "rotate") {
    const key = await regenerateProjectKey(orgKey, projectId);
    if (options.json) process.stdout.write(`${JSON.stringify({ project: projectId })}\n`);
    else {
      process.stdout.write(`Rotated the key for ${projectId}. Every previous key stopped immediately.\n`);
      printKeyOnce(key);
    }
    return 0;
  }

  if (!options.revokeUpstream) {
    // Deleting without revoking leaves the office's Google/Microsoft grants
    // live. That is never what an operator wants, so it is not the default.
    throw new UsageError(
      "decommission also needs --revoke-upstream. Without it the project is deleted but the office's upstream credentials stay live, which is not a real offboarding.",
    );
  }
  const { revokeJobId } = await deleteProject(orgKey, projectId);
  if (options.json) process.stdout.write(`${JSON.stringify({ project: projectId, revokeJobId })}\n`);
  else {
    process.stdout.write(
      `Decommissioned ${projectId}. Composio accepted the revocation of this office's upstream credentials (job ${revokeJobId}).\n`,
    );
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (cause) {
    const known = cause instanceof UsageError || (cause instanceof Error && cause.name === "ComposioError");
    process.stderr.write(`${known ? cause.message : "The Composio request failed. Nothing was reported as done; check the project in the Composio dashboard before retrying."}\n`);
    process.exitCode = 1;
  }
}

export { parseArgs, ORG_KEY_ENV, COMPOSIO_PLATFORM_API };
