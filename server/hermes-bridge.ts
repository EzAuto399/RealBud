// Zero-terminal worker bridge: RealBud takes the PM's input and delivers it
// to the pinned Hermes worker programmatically. The user never sees a
// terminal and never runs the hermes CLI.
//
// Model attach recipe (proven against the pinned worker's own source):
//   - API keys live in the profile's `.env` as PROVIDER_API_KEY=…
//     (hermes resolves key-provider secrets from that dotenv first).
//   - The default model lives in the profile `config.yaml` model block:
//       model:
//         default: <model-id>
//         provider: <provider-id>
//         base_url: ''
// Install runs the pinned installer as a spawned child with streamed
// output — same command the terminal used to run, no terminal.
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { augmentedPath } from "./env-path.ts";
import { HERMES_PIN, hermesMatchesPin } from "./hermes-pin.ts";
import { hermesHome, propertyProfileDir, withYamlBlock, yamlBlock } from "./hermes-pack.ts";
import { probeHermesVersion } from "./hermes-status.ts";

export interface ProviderOption {
  id: string;
  label: string;
  envVar: string;
  exampleModel: string;
}

/** Curated key providers (ids/env vars mirror the worker's own registry). */
export const PROVIDER_OPTIONS: ProviderOption[] = [
  { id: "anthropic", label: "Anthropic", envVar: "ANTHROPIC_API_KEY", exampleModel: "claude-sonnet-4-5" },
  { id: "xai", label: "xAI", envVar: "XAI_API_KEY", exampleModel: "grok-4" },
  { id: "openai-api", label: "OpenAI", envVar: "OPENAI_API_KEY", exampleModel: "gpt-5" },
  { id: "openrouter", label: "OpenRouter", envVar: "OPENROUTER_API_KEY", exampleModel: "anthropic/claude-sonnet-4.5" },
  { id: "ollama-cloud", label: "Ollama Cloud", envVar: "OLLAMA_CLOUD_API_KEY", exampleModel: "qwen3-coder:480b-cloud" },
];

export interface PreflightEntry {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PreflightResult {
  ok: boolean;
  deps: PreflightEntry[];
}

function whichOne(bin: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { timeout: 8_000, env: { ...process.env, PATH: augmentedPath() } }, (err, stdout) => {
      resolve({ ok: !err, detail: err ? "not found" : String(stdout).trim().split("\n")[0]?.slice(0, 80) ?? "" });
    });
  });
}

export async function preflight(): Promise<PreflightResult> {
  const [curl, git, py] = await Promise.all([whichOne("curl"), whichOne("git"), whichOne("python3")]);
  const deps: PreflightEntry[] = [
    { name: "curl", ok: curl.ok, detail: curl.detail },
    { name: "git", ok: git.ok, detail: git.detail },
    { name: "python3", ok: py.ok, detail: py.detail },
  ];
  return { ok: deps.every((d) => d.ok), deps };
}

// ── install job (singleton: one worker install at a time) ────────────────

export interface InstallJob {
  state: "idle" | "preflight" | "running" | "verifying" | "done" | "failed";
  lines: string[];
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
}

const installJob: InstallJob = { state: "idle", lines: [], startedAt: null, finishedAt: null, error: null };
let installProc: ChildProcess | null = null;

export function installStatus(): InstallJob {
  return { ...installJob, lines: installJob.lines.slice(-40) };
}

export function startInstall(command: string, opts?: { timeoutMs?: number }): InstallJob {
  if (installJob.state === "running" || installJob.state === "verifying" || installJob.state === "preflight") {
    return installStatus();
  }
  installJob.state = "running";
  installJob.lines = [];
  installJob.startedAt = Date.now();
  installJob.finishedAt = null;
  installJob.error = null;

  const push = (line: string) => {
    for (const part of String(line).split(/\r?\n/)) {
      const trimmed = part.trim();
      if (trimmed) installJob.lines.push(trimmed.slice(0, 200));
    }
    if (installJob.lines.length > 400) installJob.lines.splice(0, installJob.lines.length - 400);
  };

  const child = spawn("/bin/bash", ["-c", command], {
    env: { ...process.env, PATH: augmentedPath() },
    stdio: ["ignore", "pipe", "pipe"],
  });
  installProc = child;
  child.stdout?.on("data", (c) => push(String(c)));
  child.stderr?.on("data", (c) => push(String(c)));
  const timeout = setTimeout(() => {
    if (installProc === child) child.kill("SIGKILL");
  }, opts?.timeoutMs ?? 10 * 60_000);

  child.on("close", async (code) => {
    clearTimeout(timeout);
    if (installProc !== child) return;
    installProc = null;
    if (code !== 0) {
      installJob.state = "failed";
      installJob.error = `installer exited ${code}`;
      installJob.finishedAt = Date.now();
      return;
    }
    installJob.state = "verifying";
    const version = await probeHermesVersion("hermes");
    if (version && hermesMatchesPin(version)) {
      installJob.state = "done";
      installJob.lines.push(`verified ${version.trim().slice(0, 60)}`);
    } else {
      installJob.state = "failed";
      installJob.error = version
        ? `installed ${version.trim()}, pin is v${HERMES_PIN.product} (${HERMES_PIN.tag})`
        : "worker not found on PATH after install";
    }
    installJob.finishedAt = Date.now();
  });
  child.on("error", (err) => {
    clearTimeout(timeout);
    if (installProc !== child) return;
    installProc = null;
    installJob.state = "failed";
    installJob.error = err.message;
    installJob.finishedAt = Date.now();
  });
  return installStatus();
}

// ── model attach ─────────────────────────────────────────────────────────

export function providerOption(providerId: string): ProviderOption | null {
  return PROVIDER_OPTIONS.find((p) => p.id === providerId) ?? null;
}

function upsertEnvLine(envPath: string, key: string, value: string): void {
  let body = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const lines = body.length ? body.replace(/\s+$/, "").split("\n") : [];
  const pattern = new RegExp(`^${key}=`);
  const idx = lines.findIndex((line) => pattern.test(line));
  const next = `${key}=${value}`;
  if (idx >= 0) lines[idx] = next;
  else lines.push(next);
  body = lines.join("\n") + "\n";
  writeFileSync(envPath, body, { mode: 0o600 });
  try { chmodSync(envPath, 0o600); } catch { /* best effort */ }
}

export interface AttachModelInput {
  providerId: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export interface ModelStatus {
  provider: string | null;
  model: string | null;
  keyPresent: boolean;
  /** masked credential hint, e.g. "sk-a…9f2" — never the key itself */
  keyHint: string | null;
}

/** Model ids for a provider, from the worker's own cache (same data the
 * interactive picker shows). Empty when the cache has nothing — the UI keeps
 * free-text entry as the fallback. */
export function listModels(providerId: string, root?: string): string[] {
  try {
    const cache = JSON.parse(readFileSync(join(hermesHome(root), "models_dev_cache.json"), "utf8")) as Record<
      string,
      { models?: Record<string, unknown> } | undefined
    >;
    const entry = cache[providerId]?.models;
    if (!entry || typeof entry !== "object") return [];
    return Object.keys(entry)
      .filter((id) => !/imagine|video|image/i.test(id))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export function modelStatus(root?: string): ModelStatus {
  const configPath = join(propertyProfileDir(root), "config.yaml");
  const mask = (value: string): string =>
    value.length <= 8 ? `${value.slice(0, 2)}…` : `${value.slice(0, 4)}…${value.slice(-4)}`;
  let provider: string | null = null;
  let model: string | null = null;
  try {
    const block = yamlBlock(readFileSync(configPath, "utf8"), "model");
    provider = block ? /^[ \t]+provider:\s*(\S+)/m.exec(block)?.[1] ?? null : null;
    model = block ? /^[ \t]+default:\s*(\S+)/m.exec(block)?.[1] ?? null : null;
  } catch { /* no config yet */ }
  let keyPresent = false;
  let keyHint: string | null = null;
  try {
    const envPath = join(propertyProfileDir(root), ".env");
    if (existsSync(envPath)) {
      const envBody = readFileSync(envPath, "utf8");
      const providerId = provider ? providerOption(provider)?.envVar : null;
      const candidates = providerId ? [providerId] : PROVIDER_OPTIONS.map((p) => p.envVar);
      for (const envVar of candidates) {
        const match = new RegExp(`^${envVar}=(.+)$`, "m").exec(envBody);
        if (match?.[1]) {
          keyPresent = true;
          keyHint = `${envVar} ${mask(match[1]!.trim())}`;
          break;
        }
      }
    }
  } catch { /* ignore */ }
  return { provider, model, keyPresent, keyHint };
}

export function attachModel(input: AttachModelInput, opts?: { root?: string }): ModelStatus {
  const option = providerOption(input.providerId);
  if (!option) throw Object.assign(new Error("unknown provider"), { status: 400 });
  const model = String(input.model ?? "").trim();
  if (!model) throw Object.assign(new Error("model id is required"), { status: 400 });
  const key = String(input.apiKey ?? "").trim();

  const profileDir = propertyProfileDir(opts?.root);
  if (!existsSync(join(profileDir, "SOUL.md"))) {
    throw Object.assign(new Error("the worker pack is not installed — apply the pack first"), { status: 409 });
  }

  // an empty key means "keep the current credential" — but only if the new
  // provider actually has one; switching providers always needs a fresh key
  const envPath = join(profileDir, ".env");
  const hasExistingKey =
    existsSync(envPath) && new RegExp(`^${option.envVar}=.+`, "m").test(readFileSync(envPath, "utf8"));
  if (!key && !hasExistingKey) {
    throw Object.assign(new Error(`an api key is required for ${option.label}`), { status: 400 });
  }
  if (key) upsertEnvLine(envPath, option.envVar, key);

  const configPath = join(profileDir, "config.yaml");
  const existing = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const block =
    `model:\n  default: ${model}\n  provider: ${option.id}\n  base_url: ${input.baseUrl?.trim() ? JSON.stringify(input.baseUrl.trim()) : "''"}\n`;
  writeFileSync(configPath, withYamlBlock(existing, "model", block));

  const status = modelStatus(opts?.root);
  return { ...status, keyPresent: true };
}
