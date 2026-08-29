import { readLinkedToolKey } from "./linked-tools.ts";

export type ToolPeekResult = {
  ok: boolean;
  titles: string[];
  skipped?: boolean;
  error?: string;
};

function sharedNoun(slug?: string): string {
  if (slug === "github") return "repos";
  if (slug === "slack") return "channels";
  if (slug === "notion") return "pages";
  return "items";
}

function pageTitle(value: unknown, fallback: string): string {
  const clean = String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return (clean || fallback).slice(0, 80);
}

function notionObjectTitle(row: unknown): string {
  if (!row || typeof row !== "object") return "";
  const item = row as { title?: unknown; properties?: Record<string, unknown> };
  if (Array.isArray(item.title)) {
    const text = item.title
      .map((bit) => (bit && typeof bit === "object" ? String((bit as { plain_text?: unknown }).plain_text ?? "") : ""))
      .join("");
    if (text.trim()) return pageTitle(text, "");
  }
  for (const prop of Object.values(item.properties ?? {})) {
    if (!prop || typeof prop !== "object") continue;
    const field = prop as { type?: unknown; title?: unknown };
    if (field.type !== "title" || !Array.isArray(field.title)) continue;
    const text = field.title
      .map((bit) => (bit && typeof bit === "object" ? String((bit as { plain_text?: unknown }).plain_text ?? "") : ""))
      .join("");
    if (text.trim()) return pageTitle(text, "");
  }
  return "";
}

async function peekNotion(key: string, fetchImpl: typeof fetch): Promise<ToolPeekResult> {
  try {
    const res = await fetchImpl("https://api.notion.com/v1/search", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "notion-version": "2022-06-28",
        "content-type": "application/json",
      },
      body: JSON.stringify({ page_size: 8 }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, titles: [], error: "Notion did not accept the saved key." };
    }
    if (!res.ok) {
      return { ok: false, titles: [], error: "Notion did not return pages just now." };
    }
    const body = await res.json() as { results?: unknown };
    const titles = (Array.isArray(body.results) ? body.results : [])
      .map((row) => notionObjectTitle(row))
      .filter(Boolean)
      .slice(0, 8);
    return { ok: true, titles };
  } catch {
    return { ok: false, titles: [], error: "Could not reach Notion to list pages." };
  }
}

async function peekGithub(key: string, fetchImpl: typeof fetch): Promise<ToolPeekResult> {
  try {
    const res = await fetchImpl("https://api.github.com/user/repos?per_page=8&sort=updated", {
      headers: {
        authorization: `Bearer ${key}`,
        accept: "application/vnd.github+json",
        "user-agent": "RealBud",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, titles: [], error: "GitHub did not accept the saved key." };
    }
    if (!res.ok) {
      return { ok: false, titles: [], error: "GitHub did not return repos just now." };
    }
    const body = await res.json() as unknown;
    const rows = Array.isArray(body) ? body : [];
    const titles = rows
      .map((row) => {
        if (!row || typeof row !== "object") return "";
        const repo = row as { full_name?: unknown; name?: unknown };
        return pageTitle(repo.full_name ?? repo.name, "");
      })
      .filter(Boolean)
      .slice(0, 8);
    return { ok: true, titles };
  } catch {
    return { ok: false, titles: [], error: "Could not reach GitHub to list repos." };
  }
}

async function peekSlack(key: string, fetchImpl: typeof fetch): Promise<ToolPeekResult> {
  try {
    const res = await fetchImpl("https://slack.com/api/conversations.list?limit=8&exclude_archived=true", {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, titles: [], error: "Slack did not accept the saved key." };
    }
    if (!res.ok) {
      return { ok: false, titles: [], error: "Slack did not return channels just now." };
    }
    const body = await res.json() as { ok?: unknown; error?: unknown; channels?: unknown };
    if (body.ok !== true) {
      return { ok: false, titles: [], error: "Slack did not accept the saved key." };
    }
    const rows = Array.isArray(body.channels) ? body.channels : [];
    const titles = rows
      .map((row) => {
        if (!row || typeof row !== "object") return "";
        return pageTitle((row as { name?: unknown }).name, "");
      })
      .filter(Boolean)
      .slice(0, 8);
    return { ok: true, titles };
  } catch {
    return { ok: false, titles: [], error: "Could not reach Slack to list channels." };
  }
}

export function linkedToolPeekCopy(input: {
  label: string;
  account?: string;
  slug?: string;
  titles: string[];
  skipped?: boolean;
  error?: string;
}): string {
  const who = input.account && input.account !== "Key on this device"
    ? input.account
    : `A ${input.label} key`;
  const noun = sharedNoun(input.slug);
  if (input.error) {
    return `${who} is on this device. ${input.error} Ask still cannot send.`;
  }
  if (input.skipped) {
    return `${who} is on this device. Live list is off in this test. Ask still cannot send.`;
  }
  if (input.titles.length) {
    return `${who} is on this device. Visible now: ${input.titles.join("; ")}. Ask still cannot send.`;
  }
  return `${who} is on this device. No ${noun} are shared with this integration yet. Ask still cannot send.`;
}

/** RealBud holds the key and lists what that integration can see. Hermes never receives the secret. */
export async function peekLinkedTool(
  slug: string,
  opts?: { fetch?: typeof fetch; key?: string },
): Promise<ToolPeekResult> {
  if (process.env.REALBUD_TOOL_VERIFY === "0" && !opts?.fetch) {
    return { ok: true, titles: [], skipped: true };
  }
  const key = opts?.key ?? readLinkedToolKey(slug);
  if (!key) return { ok: false, titles: [], error: "No key is on this device for that app." };
  const fetchImpl = opts?.fetch ?? fetch;
  if (slug === "notion") return peekNotion(key, fetchImpl);
  if (slug === "github") return peekGithub(key, fetchImpl);
  if (slug === "slack") return peekSlack(key, fetchImpl);
  return { ok: false, titles: [], error: `${slug} is on this device. A live list for that app is not wired yet.` };
}
