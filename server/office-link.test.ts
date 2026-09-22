import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOfficeLink, installationWorkerVersion, websiteOrigin } from "./office-link.ts";
const roots: string[] = [];
const code = `rb1_${"a".repeat(64)}`;
function fixture(fetcher: typeof fetch) {
  const root = mkdtempSync(join(tmpdir(), "realbud-link-")); roots.push(root);
  const report = vi.fn(async () => ({ appVersion: "0.1.19", workerVersion: "Hermes Agent v0.21.3 (2026.9.14)", workerReady: true }));
  const create = () => createOfficeLink({ directory: root, appVersion: "0.1.19", fetch: fetcher, report });
  return { root, create, app: create(), report, file: join(root, "office-link/link.json") };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("website installation link", () => {
  it("persists one private identity before redemption and safely retries a lost response after restart", async () => {
    const bodies: any[] = [];
    const fetcher = vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(init.body); bodies.push(body);
      if (bodies.length === 1) throw new Error("response lost");
      return Response.json({ installationId: body.id, companyId: "office-a", agencyLabel: "Synthetic Office" });
    }) as unknown as typeof fetch;
    const { app, create, file } = fixture(fetcher);
    await expect(app.link({ code, label: "Reception Mac" })).rejects.toThrow(/could not be reached/);
    expect((await app.status()).state).toBe("pending");
    await expect(app.link({ code: `rb1_${"c".repeat(64)}`, label: "Other" })).rejects.toThrow(/original code/);
    expect(bodies).toHaveLength(1);
    const restarted = create(); await restarted.link({ code, label: "Reception Mac" });
    expect(bodies[0]).toEqual(bodies[1]);
    expect((await restarted.status()).state).toBe("linked");
    expect(await restarted.credentials()).toEqual({ installationId: bodies[0].id, token: bodies[0].token, companyId: "office-a", agencyLabel: "Synthetic Office" });
    expect(JSON.stringify(await restarted.status())).not.toContain(bodies[0].token);
    expect(readFileSync(file, "utf8")).not.toContain(code);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });
  it("sends only installation metadata, stops on revocation, and cannot silently move offices", async () => {
    const calls: any[] = [];
    const { app, report } = fixture(vi.fn(async (url, init) => {
      calls.push({ url, init });
      if (String(url).endsWith("redeem")) { const body = JSON.parse(String(init?.body)); return Response.json({ installationId: body.id, companyId: "office-a", agencyLabel: "Synthetic Office" }); }
      return Response.json({}, { status: 401 });
    }));
    await app.link({ code, label: "Desk" });
    await expect(app.link({ code, label: "Different office" })).rejects.toThrow(/Disconnect/);
    await app.report(); expect((await app.status()).state).toBe("revoked");
    expect(await app.credentials()).toBeNull();
    expect(Object.keys(JSON.parse(calls[1].init.body)).sort()).toEqual(["appVersion", "workerReady", "workerVersion"]);
    expect(calls[1].url).toBe("https://realbud.app/api/installations/report");
    expect(calls[1].init.redirect).toBe("error");
    await app.report(); expect(report).toHaveBeenCalledTimes(1);
    await app.disconnect(); expect((await app.status()).state).toBe("unlinked");
  });
  it("keeps the link when reporting or disconnecting fails", async () => {
    const { app } = fixture(vi.fn(async (url, init) => {
      if (String(url).endsWith("redeem")) { const body = JSON.parse(String(init?.body)); return Response.json({ installationId: body.id, companyId: "office-a", agencyLabel: "Synthetic Office" }); }
      return Response.json({}, { status: 503 });
    }));
    await app.link({ code, label: "Desk" });
    await expect(app.report()).rejects.toThrow(/did not accept/);
    expect((await app.status()).lastReportedAt).toBeUndefined();
    await expect(app.disconnect()).rejects.toThrow(/could not be revoked/);
    expect((await app.status()).state).toBe("linked");
  });
  it("does not contact the website for an unlinked desk and rejects unsafe local state", async () => {
    const fetcher = vi.fn(); const { app, file } = fixture(fetcher);
    await app.report(); expect(fetcher).not.toHaveBeenCalled();
    await expect(app.link({ code: "bad", label: "Desk" })).rejects.toThrow(/Paste/);
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockRejectedValue(new Error("offline"));
    await expect(app.link({ code, label: "Desk" })).rejects.toThrow();
    writeFileSync(file, '{"token":"never-expose-this"');
    await expect(app.status()).rejects.toThrow("The saved website link needs recovery.");
    if (process.platform !== "win32") { chmodSync(file, 0o644); await expect(app.status()).rejects.toThrow(/private-file/); }
  });
});

describe("zero-touch provisioning through the website link", () => {
  const provisioning = {
    version: 1,
    service: { companyId: "office-a", hostInstallationId: "fictional-host-1" },
    connector: { endpoint: "https://connections.fictional-service.invalid", credential: `rbc_${"b".repeat(64)}`, profile: "property", apps: ["gmail"] },
    model: { provider: "modelvia", baseUrl: "https://api.modelvia.dev/v1", projectId: "proj-fictional-01", key: `rbk_${"a".repeat(40)}`, keyId: "rbkkey-01", spendCapLabel: "AU$40 per month" },
  };
  const sink = () => {
    const applied: any[] = []; let state: "none" | "active" | "withdrawn" = "none";
    return { applied,
      apply: vi.fn(async (value: any, id: string) => { applied.push({ value, id }); state = "active"; }),
      withdraw: vi.fn(async () => { const was = state === "active"; if (was) state = "withdrawn"; return was; }),
      withdrawn: vi.fn(async () => state === "withdrawn"),
      reconcile: vi.fn(async () => false),
      clear: vi.fn(async () => { state = "none"; }),
    };
  };
  const linked = (body: any, extra: any = {}) => Response.json({ installationId: body.id, companyId: "office-a", agencyLabel: "Synthetic Office", ...extra });

  it("applies the grant before the computer reads as linked and never echoes the model key", async () => {
    const p = sink();
    const root = mkdtempSync(join(tmpdir(), "realbud-link-")); roots.push(root);
    const app = createOfficeLink({ directory: root, appVersion: "0.1.19", provisioning: p,
      report: async () => ({ appVersion: "0.1.19", workerVersion: null, workerReady: true }),
      fetch: vi.fn(async (_u: any, init: any) => linked(JSON.parse(init.body), { provisioning })) as any });
    await app.link({ code, label: "Reception Mac" });
    expect(p.apply).toHaveBeenCalledTimes(1);
    expect(p.applied[0].value.model.key).toBe(provisioning.model.key);
    expect(p.applied[0].id).toBe((await app.status()).id);
    expect((await app.status()).state).toBe("linked");
    expect(JSON.stringify(await app.status())).not.toContain(provisioning.model.key);
    expect(readFileSync(join(root, "office-link/link.json"), "utf8")).not.toContain(provisioning.model.key);
  });

  it("refuses a grant for another office, an unsupported build, and a vendor organization key", async () => {
    const reply = (extra: any) => {
      const p = sink();
      const app = createOfficeLink({ directory: mkdtempSync(join(tmpdir(), "realbud-link-")), appVersion: "0.1.19", provisioning: p,
        report: async () => ({ appVersion: "0.1.19", workerVersion: null, workerReady: true }),
        fetch: vi.fn(async (_u: any, init: any) => linked(JSON.parse(init.body), extra)) as any });
      return { app, p };
    };
    const other = reply({ provisioning: { ...provisioning, service: { companyId: "office-b", hostInstallationId: "h" } } });
    await expect(other.app.link({ code, label: "Desk" })).rejects.toThrow(/different office/);
    expect(other.p.apply).not.toHaveBeenCalled();
    const org = reply({ provisioning: { ...provisioning, model: { ...provisioning.model, key: `ak_${"c".repeat(32)}` } } });
    await expect(org.app.link({ code, label: "Desk" })).rejects.toThrow(/vendor key/);
    // A build with no provisioning support must hold, never link half set up.
    const unwired = createOfficeLink({ directory: mkdtempSync(join(tmpdir(), "realbud-link-")), appVersion: "0.1.19",
      report: async () => ({ appVersion: "0.1.19", workerVersion: null, workerReady: true }),
      fetch: vi.fn(async (_u: any, init: any) => linked(JSON.parse(init.body), { provisioning })) as any });
    await expect(unwired.link({ code, label: "Desk" })).rejects.toThrow(/cannot finish automatic service setup/);
    expect((await unwired.status()).state).toBe("pending");
  });

  it("withdraws service access on a website 403 and keeps the records, and releases it on disconnect", async () => {
    const p = sink();
    let revoke = false;
    const app = createOfficeLink({ directory: mkdtempSync(join(tmpdir(), "realbud-link-")), appVersion: "0.1.19", provisioning: p,
      report: async () => ({ appVersion: "0.1.19", workerVersion: null, workerReady: true }),
      fetch: vi.fn(async (url: any, init: any) => String(url).endsWith("redeem")
        ? linked(JSON.parse(init.body), { provisioning })
        : Response.json({}, { status: revoke ? 403 : 200 })) as any });
    await app.link({ code, label: "Desk" });
    revoke = true;
    await app.report();
    expect(p.withdraw).toHaveBeenCalledTimes(1);
    expect(p.reconcile).toHaveBeenCalled();
    expect(await app.status()).toMatchObject({ state: "revoked", serviceWithdrawn: true });
    await app.disconnect();
    expect(p.clear).toHaveBeenCalledTimes(1);
    expect(await app.status()).toEqual({ state: "unlinked", usage: { state: "not-linked" } });
  });
});

describe("which website this installation reports to", () => {
  const notes: string[] = [];
  const origin = (env: NodeJS.ProcessEnv) => { notes.length = 0; return websiteOrigin(env, detail => { notes.push(detail); }); };
  it("keeps the production website unless a development build overrides it with a plain https origin", () => {
    expect(origin({})).toBe("https://realbud.app");
    expect(notes).toHaveLength(0);
    expect(origin({ REALBUD_WEBSITE_ORIGIN: "https://staging.realbud.app" })).toBe("https://staging.realbud.app");
    expect(notes).toEqual(["website origin override in use: https://staging.realbud.app"]);
    // A trailing slash is still just an origin.
    expect(origin({ REALBUD_WEBSITE_ORIGIN: "https://staging.realbud.app/" })).toBe("https://staging.realbud.app");
  });
  it("refuses to move a packaged or managed customer install, and refuses an unsafe origin", () => {
    for (const guard of [{ REALBUD_PRODUCTION: "1" }, { REALBUD_MANAGED_SERVICE: "1" }]) {
      expect(origin({ ...guard, REALBUD_WEBSITE_ORIGIN: "https://staging.realbud.app" })).toBe("https://realbud.app");
      expect(notes[0]).toMatch(/production build/);
    }
    for (const unsafe of ["http://staging.realbud.app", "https://user:pass@staging.realbud.app", "https://staging.realbud.app/path",
      "https://staging.realbud.app/?x=1", "https://staging.realbud.app/#x", "not-a-url"]) {
      expect(origin({ REALBUD_WEBSITE_ORIGIN: unsafe })).toBe("https://realbud.app");
      expect(notes[0]).toMatch(/ignored/);
    }
  });
  it("sends every request to the overridden origin", async () => {
    const calls: string[] = [];
    const app = createOfficeLink({ directory: mkdtempSync(join(tmpdir(), "realbud-link-")), appVersion: "0.1.19", origin: "https://staging.realbud.app",
      report: async () => ({ appVersion: "0.1.19", workerVersion: null, workerReady: true }),
      fetch: vi.fn(async (url: any, init: any) => { calls.push(String(url)); return Response.json({ installationId: JSON.parse(init.body).id, companyId: "office-a", agencyLabel: "Synthetic Office" }); }) as any });
    await app.link({ code, label: "Desk" });
    expect(calls).toEqual(["https://staging.realbud.app/api/installations/redeem"]);
  });
});

describe("provisioning retried on the report path", () => {
  const provisioning = {
    version: 1,
    service: { companyId: "office-a", hostInstallationId: "fictional-host-1" },
    connector: { endpoint: "https://connections.fictional-service.invalid", credential: `rbc_${"b".repeat(64)}`, profile: "property", apps: ["gmail"] },
    model: { provider: "modelvia", baseUrl: "https://api.modelvia.dev/v1", projectId: "proj-fictional-01", key: `rbk_${"a".repeat(40)}`, keyId: "rbkkey-01", spendCapLabel: "AU$40 per month" },
  };
  const build = (redeemExtra: any, reportBody: () => any, active?: () => Promise<boolean>) => {
    const applied: { id: string }[] = [];
    const root = mkdtempSync(join(tmpdir(), "realbud-link-")); roots.push(root);
    const sink = { applied,
      apply: vi.fn(async (_v: any, id: string) => { applied.push({ id }); }),
      withdraw: vi.fn(async () => false), withdrawn: vi.fn(async () => false),
      reconcile: vi.fn(async () => false), clear: vi.fn(async () => {}),
      ...(active ? { active } : {}) };
    const create = () => createOfficeLink({ directory: root, appVersion: "0.1.19", provisioning: sink,
      report: async () => ({ appVersion: "0.1.19", workerVersion: null, workerReady: true }),
      fetch: vi.fn(async (url: any, init: any) => String(url).endsWith("redeem")
        ? Response.json({ installationId: JSON.parse(init.body).id, companyId: "office-a", agencyLabel: "Synthetic Office", ...redeemExtra })
        : Response.json(reportBody())) as any });
    return { sink, create, app: create() };
  };

  it("applies a grant the report reply carries after a redeem-time failure, once, even across a restart", async () => {
    const { sink, app, create } = build({}, () => ({ provisioning }));
    await app.link({ code, label: "Desk" });
    expect(sink.apply).not.toHaveBeenCalled();
    await app.report();
    expect(sink.apply).toHaveBeenCalledTimes(1);
    expect(sink.applied[0].id).toBe((await app.status()).id);
    await app.report();
    expect(sink.apply).toHaveBeenCalledTimes(1);
    // The durable marker survives a restart, so a repeating portal cannot
    // replace a live grant with whatever the next reply happens to carry.
    await create().report();
    expect(sink.apply).toHaveBeenCalledTimes(1);
  });

  it("ignores a report grant when one is already active, and when redeem already provisioned", async () => {
    const stillActive = build({}, () => ({ provisioning }), async () => true);
    await stillActive.app.link({ code, label: "Desk" });
    await stillActive.app.report();
    expect(stillActive.sink.apply).not.toHaveBeenCalled();

    const atRedeem = build({ provisioning }, () => ({ provisioning }));
    await atRedeem.app.link({ code, label: "Desk" });
    await atRedeem.app.report();
    expect(atRedeem.sink.apply).toHaveBeenCalledTimes(1);
  });

  it("treats a stated skip as no provisioning and never blocks linking or reporting", async () => {
    const { sink, app } = build({ provisioning: { skipped: "no_platform_customer" } }, () => ({ provisioning: { skipped: "no_platform_customer" } }));
    await app.link({ code, label: "Desk" });
    expect((await app.status()).state).toBe("linked");
    await app.report();
    expect(sink.apply).not.toHaveBeenCalled();
    expect((await app.status()).lastReportedAt).toBeTruthy();
    // A report reply with no provisioning key at all is equally uneventful.
    const plain = build({}, () => ({ ok: true }));
    await plain.app.link({ code, label: "Desk" });
    await plain.app.report();
    expect(plain.sink.apply).not.toHaveBeenCalled();
  });

  it("refuses a report grant for another office rather than applying it", async () => {
    const { sink, app } = build({}, () => ({ provisioning: { ...provisioning, service: { companyId: "office-b", hostInstallationId: "h" } } }));
    await app.link({ code, label: "Desk" });
    await expect(app.report()).rejects.toThrow(/different office/);
    expect(sink.apply).not.toHaveBeenCalled();
  });
});

describe("AI usage for the current month", () => {
  const period = new Date().toISOString().slice(0, 7);
  const body = (over: Record<string, unknown> = {}) => ({ period, requests: 12, tokens: { input: "900", output: "100" },
    money: { customerNetNanoAud: "41230000000" }, monthlyCapNanoAud: "80000000000", remainingNanoAud: "38770000000",
    updatedAt: "2026-09-22T03:00:00.000Z", ...over });
  const linked = (init: any) => Response.json({ installationId: JSON.parse(init.body).id, companyId: "office-a", agencyLabel: "Synthetic Office" });
  const app = (usageReply: () => Response) => {
    const calls: string[] = [];
    const link = createOfficeLink({ directory: mkdtempSync(join(tmpdir(), "realbud-link-")), appVersion: "0.1.19",
      report: async () => ({ appVersion: "0.1.19", workerVersion: null, workerReady: true }),
      fetch: vi.fn(async (url: any, init: any) => { calls.push(String(url)); return String(url).includes("redeem") ? linked(init) : usageReply(); }) as any });
    return { link, calls };
  };

  it("asks once per three minutes, sends the bearer token, and never persists the figures", async () => {
    const { link, calls } = app(() => Response.json(body()));
    await link.link({ code, label: "Desk" });
    const first = await link.usage();
    expect(first).toEqual({ state: "ready", usage: { ...body(), updatedAt: "2026-09-22T03:00:00.000Z" } });
    expect(calls.at(-1)).toBe(`https://realbud.app/api/installations/usage?period=${period}`);
    await link.usage(); await link.usage();
    expect(calls.filter(url => url.includes("usage"))).toHaveLength(1);
    // Status carries the cached figures without a second request.
    expect((await link.status()).usage).toEqual(first);
    expect(calls.filter(url => url.includes("usage"))).toHaveLength(1);
  });

  it("maps an unreachable, refusing or malformed account to one honest state", async () => {
    for (const reply of [
      () => Response.json({}, { status: 500 }),
      () => Response.json({}, { status: 403 }),
      () => Response.json(body({ period: "2020-01" })),
      () => Response.json(body({ requests: -1 })),
      () => Response.json(body({ tokens: { input: "900", output: "not-a-number" } })),
      () => Response.json({ ...body(), surprise: 1 }),
    ]) {
      const { link } = app(reply);
      await link.link({ code, label: "Desk" });
      expect(await link.usage()).toEqual({ state: "unavailable" });
      // A 403 here is not revocation: the report loop stays the authority.
      expect((await link.status()).state).toBe("linked");
    }
  });

  it("retries a dropped connection or a 5xx once, and a refusal not at all", async () => {
    const replies = (list: (() => Response)[]) => { let n = 0; return () => { const next = list[Math.min(n++, list.length - 1)]!; return next(); }; };
    const flaky = app(replies([() => Response.json({}, { status: 503 }), () => Response.json(body())]));
    await flaky.link.link({ code, label: "Desk" });
    expect((await flaky.link.usage()).state).toBe("ready");
    expect(flaky.calls.filter(url => url.includes("usage"))).toHaveLength(2);

    const dropped = app(replies([() => { throw new TypeError("synthetic network failure"); }, () => Response.json(body())]));
    await dropped.link.link({ code, label: "Desk" });
    expect((await dropped.link.usage()).state).toBe("ready");
    expect(dropped.calls.filter(url => url.includes("usage"))).toHaveLength(2);

    // Bounded: a second 5xx is the answer, not a reason to keep asking.
    const down = app(() => Response.json({}, { status: 502 }));
    await down.link.link({ code, label: "Desk" });
    expect(await down.link.usage()).toEqual({ state: "unavailable" });
    expect(down.calls.filter(url => url.includes("usage"))).toHaveLength(2);

    const refused = app(() => Response.json({}, { status: 403 }));
    await refused.link.link({ code, label: "Desk" });
    expect(await refused.link.usage()).toEqual({ state: "unavailable" });
    expect(refused.calls.filter(url => url.includes("usage"))).toHaveLength(1);
  });

  it("never repeats a report write, even on a 5xx", async () => {
    const { link, calls } = app(() => Response.json({}, { status: 503 }));
    await link.link({ code, label: "Desk" });
    await expect(link.report()).rejects.toThrow(/did not accept/);
    expect(calls.filter(url => url.endsWith("/report"))).toHaveLength(1);
  });

  it("refreshes after three minutes and serves the cached figures before then", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));
      let requests = 0;
      const { link, calls } = app(() => Response.json(body({ period: "2026-09", requests: ++requests })));
      await link.link({ code, label: "Desk" });
      expect(await link.usage()).toMatchObject({ state: "ready", usage: { requests: 1 } });
      vi.setSystemTime(new Date("2026-09-15T12:02:59Z"));
      expect(await link.usage()).toMatchObject({ usage: { requests: 1 } });
      expect(calls.filter(url => url.includes("usage"))).toHaveLength(1);
      vi.setSystemTime(new Date("2026-09-15T12:03:00Z"));
      expect(await link.usage()).toMatchObject({ usage: { requests: 2 } });
      expect(calls.filter(url => url.includes("usage"))).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  it("reports not-linked without contacting the account, and rejects a bad month", async () => {
    const { link, calls } = app(() => Response.json(body()));
    expect(await link.usage()).toEqual({ state: "not-linked" });
    expect(calls).toHaveLength(0);
    expect((await link.status()).usage).toEqual({ state: "not-linked" });
    await link.link({ code, label: "Desk" });
    await expect(link.usage("2026-13")).rejects.toThrow(/YYYY-MM/);
    await expect(link.usage("september")).rejects.toThrow(/YYYY-MM/);
  });

  it("starts the first check in the background so status stays a local read", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { link } = app(() => Response.json(body()));
    const slow = createOfficeLink({ directory: mkdtempSync(join(tmpdir(), "realbud-link-")), appVersion: "0.1.19",
      report: async () => ({ appVersion: "0.1.19", workerVersion: null, workerReady: true }),
      fetch: vi.fn(async (url: any, init: any) => {
        if (String(url).includes("redeem")) return linked(init);
        await gate; return Response.json(body());
      }) as any });
    await slow.link({ code, label: "Desk" });
    expect((await slow.status()).usage).toEqual({ state: "checking" });
    release?.();
    await link.link({ code, label: "Desk" });
  });
});

it("reports a bounded product version without paths or upstream diagnostics", () => {
  const raw = "Hermes Agent v0.21.3 (2026.9.14) · upstream abcdef12 · local 345cd2b0\nInstall directory: /Users/fixture/private-worker\nUpdate available: 4022 commits behind";
  expect(installationWorkerVersion(raw)).toBe("0.21.3");
  expect(installationWorkerVersion(null)).toBeNull();
  expect(installationWorkerVersion("could not run worker")).toBeNull();
});
