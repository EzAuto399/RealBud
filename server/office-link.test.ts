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
  it("accepts a loopback http website only in the local test lab, never on a production build", () => {
    const lab = { REALBUD_TEST_LAB: "1", REALBUD_WEBSITE_ORIGIN: "http://127.0.0.1:43123" };
    expect(origin(lab)).toBe("http://127.0.0.1:43123");
    expect(notes).toEqual(["website origin override in use (test lab loopback): http://127.0.0.1:43123"]);
    expect(origin({ REALBUD_WEBSITE_ORIGIN: "http://127.0.0.1:43123" })).toBe("https://realbud.app");
    expect(notes[0]).toMatch(/ignored: not a plain https origin/);
    for (const guard of [{ REALBUD_PRODUCTION: "1" }, { REALBUD_MANAGED_SERVICE: "1" }]) {
      expect(origin({ ...lab, ...guard })).toBe("https://realbud.app");
      expect(notes[0]).toMatch(/production build/);
    }
    for (const unsafe of ["http://127.0.0.1", "http://localhost:43123", "http://10.0.0.2:43123", "http://127.0.0.1:43123/path",
      "http://127.0.0.1:43123/?x=1", "http://127.0.0.1:43123/#x", "http://user:pass@127.0.0.1:43123"]) {
      expect(origin({ REALBUD_TEST_LAB: "1", REALBUD_WEBSITE_ORIGIN: unsafe })).toBe("https://realbud.app");
      expect(notes[0]).toMatch(/ignored/);
    }
    // https behaviour is unchanged by the lab flag.
    expect(origin({ REALBUD_TEST_LAB: "1", REALBUD_WEBSITE_ORIGIN: "https://staging.realbud.app" })).toBe("https://staging.realbud.app");
    expect(notes).toEqual(["website origin override in use: https://staging.realbud.app"]);
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

describe("linking through the browser", () => {
  const ORIGIN = "https://realbud.app";
  const approvalUrl = `${ORIGIN}/link/${"A".repeat(43)}`;
  const later = () => new Date(Date.now() + 10 * 60_000).toISOString();
  const provisioning = {
    version: 1,
    service: { companyId: "office-a", hostInstallationId: "fictional-host-1" },
    connector: { endpoint: "https://connections.fictional-service.invalid", credential: `rbc_${"b".repeat(64)}`, profile: "property", apps: ["gmail"] },
    model: { provider: "modelvia", baseUrl: "https://api.modelvia.dev/v1", projectId: "proj-fictional-01", key: `rbk_${"a".repeat(40)}`, keyId: "rbkkey-01", spendCapLabel: "AU$40 per month" },
  };
  /** A fake website: link requests, the bearer-checked status poll and cancel, and the report path. */
  function website(options: { issued?: (body: any) => unknown; createStatus?: number; reportGate?: Promise<void>; cancelStatus?: number; cancelReply?: unknown } = {}) {
    const requests: any[] = [];
    const calls: { route: string; method: string; auth?: string; body?: any }[] = [];
    let answer: "pending" | "linked" | "expired" | "declined" | "foreign" = "pending";
    let statusFailures = 0;
    const fetcher = vi.fn(async (url: any, init: any) => {
      const route = String(url).slice(`${ORIGIN}/api/installations/`.length);
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ route, method: init.method, auth: init.headers?.Authorization, body });
      expect(init.redirect).toBe("error");
      if (route === "link-requests" && init.method === "POST") {
        if (options.createStatus) return Response.json({}, { status: options.createStatus });
        requests.push(body);
        return Response.json(options.issued ? options.issued(body) : { version: 1, purpose: "installation-link-issued", approvalUrl, displayCode: "ABCD-EFGH", expiresAt: later() });
      }
      if (route === "link-requests/status" && init.method === "POST") {
        if (statusFailures > 0) { statusFailures--; throw new Error("connection reset"); }
        const request = requests.find(item => item.id === body.id);
        if (!request || init.headers.Authorization !== `Bearer ${request.token}`) return Response.json({}, { status: 401 });
        const base = { version: 1, purpose: "installation-link-status" };
        if (answer === "pending") return Response.json({ ...base, state: "pending", expiresAt: later() });
        if (answer === "linked" || answer === "foreign") return Response.json({ ...base, state: "linked", companyId: "office-a", agencyLabel: "Synthetic Office",
          installationId: answer === "linked" ? request.id : "0f8fad5b-d9cb-469f-a165-70867728950e" });
        return Response.json({ ...base, state: answer });
      }
      if (route === "link-requests/cancel" && init.method === "POST") {
        if (options.cancelStatus) return Response.json({}, { status: options.cancelStatus });
        if (options.cancelReply !== undefined) return Response.json(options.cancelReply);
        const request = requests.find(item => item.id === body.id);
        if (!request || init.headers.Authorization !== `Bearer ${request.token}`) return Response.json({}, { status: 401 });
        // As the SQL does: only a pending request changes, and it becomes declined.
        if (answer === "pending") answer = "declined";
        const base = { version: 1, purpose: "installation-link-status" };
        if (answer === "linked" || answer === "foreign") return Response.json({ ...base, state: "linked", companyId: "office-a", agencyLabel: "Synthetic Office",
          installationId: answer === "linked" ? request.id : "0f8fad5b-d9cb-469f-a165-70867728950e" });
        return Response.json({ ...base, state: answer });
      }
      if (route === "report" && init.method === "POST") { await options.reportGate; return Response.json({ provisioning }); }
      if (route === "report" && init.method === "DELETE") return Response.json({}, { status: 401 });
      return Response.json({}, { status: 404 });
    }) as unknown as typeof fetch;
    return { fetcher, requests, calls, answer: (value: typeof answer) => { answer = value; }, current: () => answer, failStatus: (times: number) => { statusFailures = times; } };
  }
  function desk(site: ReturnType<typeof website>) {
    const root = mkdtempSync(join(tmpdir(), "realbud-link-")); roots.push(root);
    const applied: any[] = [];
    const sink = { apply: vi.fn(async (value: any, id: string) => { applied.push({ value, id }); }),
      withdraw: vi.fn(async () => false), withdrawn: vi.fn(async () => false), reconcile: vi.fn(async () => false), clear: vi.fn(async () => {}) };
    const report = vi.fn(async () => ({ appVersion: "0.1.19", workerVersion: null, workerReady: true }));
    const create = () => createOfficeLink({ directory: root, appVersion: "0.1.19", platform: "darwin", fetch: site.fetcher, report, provisioning: sink });
    return { root, create, app: create(), report, sink, applied, file: join(root, "office-link/link.json") };
  }
  const routes = (site: ReturnType<typeof website>) => site.calls.map(call => `${call.method} ${call.route}`);

  it("starts one request, keeps its token on this computer, and resumes it after a restart", async () => {
    const site = website(); const { app, create, file } = desk(site);
    const started = await app.beginBrowserLink({ label: "  Reception Mac  " });
    expect(started).toEqual({ approvalUrl, displayCode: "ABCD-EFGH", expiresAt: expect.any(String) });
    const [sent] = site.requests;
    expect(Object.keys(sent).sort()).toEqual(["appVersion", "id", "label", "platform", "purpose", "token", "version"]);
    expect(sent).toMatchObject({ version: 1, purpose: "installation-link-request", label: "Reception Mac", platform: "darwin", appVersion: "0.1.19" });
    expect(sent.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(sent.token).toMatch(/^[a-f0-9]{64}$/);
    const status = await app.status();
    expect(status).toMatchObject({ state: "pending", label: "Reception Mac", browser: started });
    expect(JSON.stringify(status)).not.toContain(sent.token);
    expect(JSON.stringify(started)).not.toContain(sent.token);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    // One pending request at a time: starting again, even after a restart, resumes it.
    expect(await app.beginBrowserLink({ label: "Another name" })).toEqual(started);
    const restarted = create();
    expect((await restarted.status()).browser).toEqual(started);
    expect(await restarted.beginBrowserLink({ label: "Reception Mac" })).toEqual(started);
    expect(site.requests).toHaveLength(1);
    // The pasted-code path cannot silently replace a waiting approval.
    await expect(restarted.link({ code, label: "Reception Mac" })).rejects.toThrow(/Cancel the browser approval/);
    // The restarted process polls with the same token.
    expect(await restarted.browserLinkStatus()).toEqual({ state: "pending", ...started });
    expect(site.calls.at(-1)).toMatchObject({ route: "link-requests/status", auth: `Bearer ${sent.token}`, body: { version: 1, purpose: "installation-link-status", id: sent.id } });
  });

  it("stores an approved link as redeem does and reports once, so provisioning arrives through the report path", async () => {
    let open!: () => void;
    const site = website({ reportGate: new Promise<void>(resolve => { open = resolve; }) }); const { app, report, sink, applied } = desk(site);
    await app.beginBrowserLink({ label: "Reception Mac" });
    const [sent] = site.requests;
    expect((await app.browserLinkStatus()).state).toBe("pending");
    expect(report).not.toHaveBeenCalled();
    site.answer("linked");
    expect(await app.browserLinkStatus()).toEqual({ state: "linked", agencyLabel: "Synthetic Office" });
    // Approval carries no credential: until the report settles, the link reads
    // linked with model access not yet set up and nothing reported.
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1));
    expect(await app.status()).toMatchObject({ state: "linked", agencyLabel: "Synthetic Office", provisioned: false });
    expect((await app.status()).lastReportedAt).toBeUndefined();
    expect(sink.apply).not.toHaveBeenCalled();
    open();
    await vi.waitFor(async () => expect((await app.status()).provisioned).toBe(true));
    expect(report).toHaveBeenCalledTimes(1);
    expect(routes(site).filter(route => route === "POST report")).toHaveLength(1);
    expect(site.calls.find(call => call.route === "report")?.auth).toBe(`Bearer ${sent.token}`);
    expect(sink.apply).toHaveBeenCalledTimes(1);
    expect(applied[0].id).toBe(sent.id);
    expect(await app.credentials()).toEqual({ installationId: sent.id, token: sent.token, companyId: "office-a", agencyLabel: "Synthetic Office" });
    const status = await app.status();
    expect(status).toMatchObject({ state: "linked", agencyLabel: "Synthetic Office", label: "Reception Mac" });
    expect(status.browser).toBeUndefined();
    expect(JSON.stringify(status)).not.toContain(provisioning.model.key);
    // Polling again answers from the stored link without asking the website.
    const polls = () => routes(site).filter(route => route === "POST link-requests/status").length;
    const before = polls();
    expect(await app.browserLinkStatus()).toEqual({ state: "linked", agencyLabel: "Synthetic Office" });
    expect(polls()).toBe(before);
    expect(report).toHaveBeenCalledTimes(1);
    await expect(app.beginBrowserLink({ label: "Reception Mac" })).rejects.toThrow(/Disconnect/);
  });

  it("clears a declined or expired request so a new one can start", async () => {
    for (const outcome of ["declined", "expired"] as const) {
      const site = website(); const { app, file } = desk(site);
      await app.beginBrowserLink({ label: "Reception Mac" });
      site.answer(outcome);
      expect(await app.browserLinkStatus()).toEqual({ state: outcome });
      expect((await app.status()).state).toBe("unlinked");
      expect(() => statSync(file)).toThrow();
      await app.beginBrowserLink({ label: "Reception Mac" });
      expect(site.requests).toHaveLength(2);
      expect(site.requests[1].id).not.toBe(site.requests[0].id);
      expect(site.requests[1].token).not.toBe(site.requests[0].token);
    }
  });

  it("replaces a request whose time has passed, revoking its token first", async () => {
    let first = true;
    const site = website({ issued: () => {
      const expiresAt = first ? new Date(Date.now() - 1000).toISOString() : later(); first = false;
      return { version: 1, purpose: "installation-link-issued", approvalUrl, displayCode: "ABCD-EFGH", expiresAt };
    } });
    const { app } = desk(site);
    await app.beginBrowserLink({ label: "Reception Mac" });
    const replaced = await app.beginBrowserLink({ label: "Reception Mac" });
    expect(Date.parse(replaced.expiresAt)).toBeGreaterThan(Date.now());
    expect(routes(site)).toEqual(["POST link-requests", "DELETE report", "POST link-requests"]);
    expect(site.calls[1].auth).toBe(`Bearer ${site.requests[0].token}`);
  });

  it("rejects an approval page off the configured website and saves nothing", async () => {
    for (const url of ["https://evil.test/link/" + "A".repeat(43), `http://realbud.app/link/${"A".repeat(43)}`, `${approvalUrl}?next=https://evil.test`]) {
      const site = website({ issued: () => ({ version: 1, purpose: "installation-link-issued", approvalUrl: url, displayCode: "ABCD-EFGH", expiresAt: later() }) });
      const { app, file } = desk(site);
      await expect(app.beginBrowserLink({ label: "Reception Mac" })).rejects.toThrow(/will not open/);
      expect((await app.status()).state).toBe("unlinked");
      expect(() => statSync(file)).toThrow();
    }
    const extra = website({ issued: () => ({ version: 1, purpose: "installation-link-issued", approvalUrl, displayCode: "ABCD-EFGH", expiresAt: later(), token: "x" }) });
    await expect(desk(extra).app.beginBrowserLink({ label: "Desk" })).rejects.toThrow(/will not open/);
  });

  it("starts every attempt after a failed or lost create with a fresh id and token", async () => {
    let attempt = 0;
    const site = website({ issued: () => {
      attempt += 1;
      if (attempt === 1) throw new Error("reply lost");
      if (attempt === 2) return { version: 1, purpose: "installation-link-issued", approvalUrl: "https://evil.test/link/" + "A".repeat(43), displayCode: "ABCD-EFGH", expiresAt: later() };
      return { version: 1, purpose: "installation-link-issued", approvalUrl, displayCode: "ABCD-EFGH", expiresAt: later() };
    } });
    const { app } = desk(site);
    await expect(app.beginBrowserLink({ label: "Reception Mac" })).rejects.toMatchObject({ code: "website_unreachable" });
    expect((await app.status()).state).toBe("unlinked");
    await expect(app.beginBrowserLink({ label: "Reception Mac" })).rejects.toThrow(/will not open/);
    await app.beginBrowserLink({ label: "Reception Mac" });
    expect(site.requests).toHaveLength(3);
    expect(new Set(site.requests.map(item => item.id)).size).toBe(3);
    expect(new Set(site.requests.map(item => item.token)).size).toBe(3);
    // Only the attempt the website answered properly is kept.
    expect((await app.status()).id).toBe(site.requests[2].id);
  });

  it("never repeats the create request, says when the website is unreachable, and refuses a bad name first", async () => {
    const down = website({ createStatus: 503 }); const { app } = desk(down);
    await expect(app.beginBrowserLink({ label: "Reception Mac" })).rejects.toMatchObject({ status: 503, code: "website_unreachable" });
    expect(routes(down)).toEqual(["POST link-requests"]);
    const refused = website({ createStatus: 400 });
    await expect(desk(refused).app.beginBrowserLink({ label: "Reception Mac" })).rejects.toThrow(/did not accept/);
    const offline = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const root = mkdtempSync(join(tmpdir(), "realbud-link-")); roots.push(root);
    const cut = createOfficeLink({ directory: root, appVersion: "0.1.19", platform: "darwin", fetch: offline, report: async () => ({ appVersion: "0.1.19", workerVersion: null, workerReady: true }) });
    await expect(cut.beginBrowserLink({ label: "Reception Mac" })).rejects.toMatchObject({ code: "website_unreachable" });
    expect(offline).toHaveBeenCalledTimes(1);
    for (const label of ["", "   ", "x".repeat(81), "Desk\nMac", 7]) await expect(cut.beginBrowserLink({ label })).rejects.toMatchObject({ status: 400 });
    expect(offline).toHaveBeenCalledTimes(1);
  });

  it("retries a status poll once after a network error and keeps the request on a bad answer", async () => {
    const site = website(); const { app } = desk(site);
    await app.beginBrowserLink({ label: "Reception Mac" });
    site.failStatus(1);
    expect((await app.browserLinkStatus()).state).toBe("pending");
    expect(routes(site).filter(route => route === "POST link-requests/status")).toHaveLength(2);
    site.failStatus(2);
    await expect(app.browserLinkStatus()).rejects.toMatchObject({ code: "website_unreachable" });
    expect((await app.status()).browser).toBeDefined();
    // A linked answer for another computer is not this computer's link.
    site.answer("foreign");
    await expect(app.browserLinkStatus()).rejects.toThrow(/different computer/);
    expect((await app.status()).state).toBe("pending");
    expect(await app.credentials()).toBeNull();
  });

  it("cancels a waiting request on the website, so the owner can no longer approve it, then forgets it", async () => {
    const site = website(); const { app, file, report } = desk(site);
    await app.beginBrowserLink({ label: "Reception Mac" });
    const [sent] = site.requests;
    expect(await app.cancelBrowserLink()).toEqual({ state: "none" });
    expect(routes(site)).toEqual(["POST link-requests", "POST link-requests/cancel"]);
    expect(site.calls[1]).toEqual({ route: "link-requests/cancel", method: "POST", auth: `Bearer ${sent.token}`, body: { version: 1, purpose: "installation-link-cancel", id: sent.id } });
    expect(site.current()).toBe("declined");
    expect((await app.status()).state).toBe("unlinked");
    expect(() => statSync(file)).toThrow();
    expect(await app.browserLinkStatus()).toEqual({ state: "none" });
    expect(await app.credentials()).toBeNull();
    expect(report).not.toHaveBeenCalled();
    // Nothing waiting: cancelling again asks nobody.
    expect(await app.cancelBrowserLink()).toEqual({ state: "none" });
    expect(site.calls).toHaveLength(2);
  });

  it("keeps the link when the owner approved before the cancel arrived, exactly as a status poll would", async () => {
    const site = website(); const { app, report, sink } = desk(site);
    await app.beginBrowserLink({ label: "Reception Mac" });
    const [sent] = site.requests;
    site.answer("linked");
    expect(await app.cancelBrowserLink()).toEqual({ state: "linked", agencyLabel: "Synthetic Office" });
    expect(await app.credentials()).toEqual({ installationId: sent.id, token: sent.token, companyId: "office-a", agencyLabel: "Synthetic Office" });
    await vi.waitFor(async () => expect((await app.status()).provisioned).toBe(true));
    const status = await app.status();
    expect(status).toMatchObject({ state: "linked", agencyLabel: "Synthetic Office", label: "Reception Mac" });
    expect(status.browser).toBeUndefined();
    expect(report).toHaveBeenCalledTimes(1);
    expect(sink.apply).toHaveBeenCalledTimes(1);
    // The approved installation is kept, never revoked.
    expect(routes(site)).not.toContain("DELETE report");
    expect(await app.browserLinkStatus()).toEqual({ state: "linked", agencyLabel: "Synthetic Office" });
  });

  it("forgets the request after one attempt when offline, and when the website says it expired or was declined", async () => {
    const site = website(); const { app, file } = desk(site);
    await app.beginBrowserLink({ label: "Reception Mac" });
    const before = site.calls.length;
    (site.fetcher as any).mockImplementation(async (_url: any, init: any) => {
      site.calls.push({ route: "offline", method: init.method });
      expect(init.signal).toBeInstanceOf(AbortSignal);
      throw new Error("offline");
    });
    expect(await app.cancelBrowserLink()).toEqual({ state: "none" });
    // One bounded attempt; an unreachable website is not asked again, nor revoked.
    expect(site.calls.length - before).toBe(1);
    expect(() => statSync(file)).toThrow();
    expect((await app.status()).state).toBe("unlinked");
    for (const outcome of ["expired", "declined"] as const) {
      const other = website(); const { app: desk2, file: file2 } = desk(other);
      await desk2.beginBrowserLink({ label: "Reception Mac" });
      other.answer(outcome);
      expect(await desk2.cancelBrowserLink()).toEqual({ state: "none" });
      expect(routes(other)).toEqual(["POST link-requests", "POST link-requests/cancel"]);
      expect(() => statSync(file2)).toThrow();
    }
  });

  it("still forgets the request when the website gives no usable answer, revoking the token in case an approval landed", async () => {
    const foreign = { version: 1, purpose: "installation-link-status", state: "linked", companyId: "office-a", agencyLabel: "Synthetic Office", installationId: "0f8fad5b-d9cb-469f-a165-70867728950e" };
    for (const options of [{ cancelStatus: 404 }, { cancelStatus: 401 }, { cancelStatus: 503 }, { cancelReply: { state: "declined" } }, { cancelReply: foreign }]) {
      const site = website(options); const { app, file } = desk(site);
      await app.beginBrowserLink({ label: "Reception Mac" });
      const [sent] = site.requests;
      expect(await app.cancelBrowserLink()).toEqual({ state: "none" });
      expect(routes(site)).toEqual(["POST link-requests", "POST link-requests/cancel", "DELETE report"]);
      expect(site.calls[2].auth).toBe(`Bearer ${sent.token}`);
      expect(() => statSync(file)).toThrow();
      expect(await app.credentials()).toBeNull();
    }
  });

  it("treats a damaged saved approval as needing recovery", async () => {
    const site = website(); const { app, file } = desk(site);
    await app.beginBrowserLink({ label: "Reception Mac" });
    const saved = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...saved, browser: { ...saved.browser, approvalUrl: "javascript:alert(1)" } }));
    await expect(app.status()).rejects.toThrow("The saved website link needs recovery.");
    writeFileSync(file, JSON.stringify({ ...saved, companyId: "office-a" }));
    await expect(app.browserLinkStatus()).rejects.toThrow("The saved website link needs recovery.");
  });
});
