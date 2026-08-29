/** Live check for a pasted tool key. Unknown slugs store only; they are not claimed live. */

export interface ToolVerifyOk {
  ok: true;
  account: string;
}

export interface ToolVerifyFail {
  ok: false;
  error: string;
}

export type ToolVerifyResult = ToolVerifyOk | ToolVerifyFail;

function accountName(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, 40) : fallback;
}

async function verifyNotion(key: string, fetchImpl: typeof fetch): Promise<ToolVerifyResult> {
  try {
    const res = await fetchImpl("https://api.notion.com/v1/users/me", {
      headers: {
        authorization: `Bearer ${key}`,
        "notion-version": "2022-06-28",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Notion did not accept this API key." };
    }
    if (!res.ok) {
      return { ok: false, error: "Notion could not confirm this API key." };
    }
    const body = await res.json() as { name?: unknown; bot?: { workspace_name?: unknown } };
    return { ok: true, account: accountName(body.bot?.workspace_name ?? body.name, "Notion") };
  } catch {
    return { ok: false, error: "Could not reach Notion to check this key." };
  }
}

async function verifySlack(key: string, fetchImpl: typeof fetch): Promise<ToolVerifyResult> {
  try {
    const res = await fetchImpl("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json() as { ok?: unknown; team?: unknown; user?: unknown; error?: unknown };
    if (!res.ok || body.ok !== true) {
      return { ok: false, error: "Slack did not accept this API key." };
    }
    return { ok: true, account: accountName(body.team ?? body.user, "Slack") };
  } catch {
    return { ok: false, error: "Could not reach Slack to check this key." };
  }
}

async function verifyGithub(key: string, fetchImpl: typeof fetch): Promise<ToolVerifyResult> {
  try {
    const res = await fetchImpl("https://api.github.com/user", {
      headers: {
        authorization: `Bearer ${key}`,
        accept: "application/vnd.github+json",
        "user-agent": "RealBud",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "GitHub did not accept this API key." };
    }
    if (!res.ok) {
      return { ok: false, error: "GitHub could not confirm this API key." };
    }
    const body = await res.json() as { login?: unknown; name?: unknown };
    return { ok: true, account: accountName(body.login ?? body.name, "GitHub") };
  } catch {
    return { ok: false, error: "Could not reach GitHub to check this key." };
  }
}

/** Confirm a named-tool key with that provider. Tests set REALBUD_TOOL_VERIFY=0. */
export async function verifyToolKey(
  slug: string,
  key: string,
  opts?: { fetch?: typeof fetch },
): Promise<ToolVerifyResult> {
  if (process.env.REALBUD_TOOL_VERIFY === "0" && !opts?.fetch) {
    return { ok: true, account: "Key on this device" };
  }
  const fetchImpl = opts?.fetch ?? fetch;
  if (slug === "notion" || /^ntn_/i.test(key)) return verifyNotion(key, fetchImpl);
  if (slug === "slack" || /^xox[abposr]-/i.test(key)) return verifySlack(key, fetchImpl);
  if (slug === "github" || /^(?:ghp|gho|ghu|ghs|ghr|github_pat)_/i.test(key)) {
    return verifyGithub(key, fetchImpl);
  }
  return { ok: true, account: "Key on this device" };
}
