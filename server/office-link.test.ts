import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOfficeLink, installationWorkerVersion, noteModelKeyAnswer, websiteOrigin } from "./office-link.ts";
import { formatCustomerCharge, formatNanoAud, parseInstallationUsage } from "../shared/office-link.ts";
import { ConfigRecoveryError, type AppConfig } from "./config.ts";
import { createWorkerModelAccess, setWorkerModelGrant } from "./worker-model-access.ts";
import { privateFixtureRoot, privateFixtureDirectory, writePrivateFixtureFile } from "./testing/private-profile-fixture.ts";
const roots: string[] = [];
const code = `rb1_${"a".repeat(64)}`;
function fixture(fetcher: typeof fetch) {
  const root = mkdtempSync(join(tmpdir(), "realbud-link-")); roots.push(root);
  const report = vi.fn(async () => ({ appVersion: "0.1.19", workerVersion: "Hermes Agent v0.21.3 (2026.9.14)", workerReady: true }));
  const create = () => createOfficeLink({ directory: root, appVersion: "0.1.19", fetch: fetcher, report });
  return { root, create, app: create(), report, file: join(root, "office-link/link.json") };
}
afterEach(() => { setWorkerModelGrant({ state: "none" }); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
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
  it("honours Retry-After on a rate-limited report, capped, without asking again early", async () => {
    let reports = 0, retryAfter = "120";
    const { app } = fixture(vi.fn(async (url, init) => {
      if (String(url).endsWith("redeem")) { const body = JSON.parse(String(init?.body)); return Response.json({ installationId: body.id, companyId: "office-a", agencyLabel: "Synthetic Office" }); }
      reports++;
      return reports % 2 ? new Response("{}", { status: 429, headers: { "Retry-After": retryAfter } }) : Response.json({});
    }));
    await app.link({ code, label: "Desk" });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await expect(app.report()).rejects.toThrow(/wait before reporting/);
      await expect(app.report()).rejects.toThrow(/wait before reporting/);
      expect(reports).toBe(1);
      vi.setSystemTime(Date.now() + 121_000);
      await app.report(); expect(reports).toBe(2);
      retryAfter = "999999";
      await expect(app.report()).rejects.toThrow(/wait before reporting/);
      vi.setSystemTime(Date.now() + 59 * 60_000);
      await expect(app.report()).rejects.toThrow(/wait before reporting/);
      expect(reports).toBe(3);
      vi.setSystemTime(Date.now() + 61_000);
      await app.report(); expect(reports).toBe(4);
    } finally { vi.useRealTimers(); }
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
    let installationId: string | undefined;
    return { applied,
      apply: vi.fn(async (value: any, id: string) => { applied.push({ value, id }); installationId = id; state = "active"; }),
      withdraw: vi.fn(async () => { const was = state === "active"; if (was) state = "withdrawn"; return was; }),
      withdrawn: vi.fn(async (id?: string) => state === "withdrawn" && (id === undefined || id === installationId)),
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

  it("asks for the signed service grant after a granted link and after each accepted report, outside the link lock", async () => {
    const p = sink();
    const root = mkdtempSync(join(tmpdir(), "realbud-link-")); roots.push(root);
    const calls: Array<{ force?: boolean }> = [];
    let app: ReturnType<typeof createOfficeLink>;
    const serviceGrant = vi.fn(async (options: { force?: boolean }) => {
      calls.push(options);
      // The hook runs after the link lock is released: a report may start.
      if (calls.length === 1) await app.report();
    });
    app = createOfficeLink({ directory: root, appVersion: "0.1.19", provisioning: { ...p, serviceGrant },
      report: async () => ({ appVersion: "0.1.19", workerVersion: null, workerReady: true }),
      fetch: vi.fn(async (url: any, init: any) => String(url).endsWith("/redeem") ? linked(JSON.parse(init.body), { provisioning }) : Response.json({ ok: true })) as any });
    await app.link({ code, label: "Reception Mac" });
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2));
    expect(calls[0]).toEqual({ force: true });
    expect(calls[1]).toEqual({ force: false });
    // A failing hook never turns into a link or report failure.
    serviceGrant.mockImplementation(async () => { throw new Error("fictional outage"); });
    await expect(app.report()).resolves.toBeUndefined();
    expect((await app.status()).state).toBe("linked");
  });

  it("does not ask for a service grant for a link that carries none", async () => {
    const serviceGrant = vi.fn(async () => {});
    const root = mkdtempSync(join(tmpdir(), "realbud-link-")); roots.push(root);
    const p = sink();
    const app = createOfficeLink({ directory: root, appVersion: "0.1.19", provisioning: { ...p, serviceGrant },
      report: async () => ({ appVersion: "0.1.19", workerVersion: null, workerReady: true }),
      fetch: vi.fn(async (_u: any, init: any) => linked(JSON.parse(init.body), { provisioning: { skipped: "no_platform_customer" } })) as any });
    await app.link({ code, label: "Reception Mac" });
    await app.report();
    expect(serviceGrant).not.toHaveBeenCalled();
  });

  it("announces a new link only after it is saved, and never when the save fails", async () => {
    const p = sink();
    const root = mkdtempSync(join(tmpdir(), "realbud-link-")); roots.push(root);
    let credentialsAtHook: unknown = "not called";
    const app = createOfficeLink({ directory: root, appVersion: "0.1.19",
      provisioning: { ...p, onLinked: vi.fn(() => { void app.credentials().then(value => { credentialsAtHook = value; }); }) },
      report: async () => ({ appVersion: "0.1.19", workerVersion: null, workerReady: true }),
      fetch: vi.fn(async (_u: any, init: any) => linked(JSON.parse(init.body), { provisioning })) as any });
    await app.link({ code, label: "Reception Mac" });
    await vi.waitFor(() => expect(credentialsAtHook).toMatchObject({ companyId: "office-a" }));

    if (process.platform === "win32") return;
    const failRoot = mkdtempSync(join(tmpdir(), "realbud-link-")); roots.push(failRoot);
    const onLinked = vi.fn();
    const failing = createOfficeLink({ directory: failRoot, appVersion: "0.1.19",
      // The link save after the grant fails: its directory stops being private.
      provisioning: { ...p, apply: vi.fn(async () => { chmodSync(join(failRoot, "office-link"), 0o755); }), onLinked },
      report: async () => ({ appVersion: "0.1.19", workerVersion: null, workerReady: true }),
      fetch: vi.fn(async (_u: any, init: any) => linked(JSON.parse(init.body), { provisioning })) as any });
    await expect(failing.link({ code, label: "Reception Mac" })).rejects.toThrow();
    expect(onLinked).not.toHaveBeenCalled();
    chmodSync(join(failRoot, "office-link"), 0o700);
  });

  /** A website and gateway pair modelled on the SQL rules: a replayed redeem or
   * a report is answered only for the id + token that first redeemed; once
   * provisioned, credentials are redelivered by rotating the one key and
   * replacing the connector credential, never by minting another. */
  const website = () => {
    const state = { owner: undefined as undefined | { id: string; token: string }, provisioned: false, keys: [] as string[], revoked: [] as string[],
      credentials: [] as string[], loseNextReply: false, reports: [] as any[] };
    const issue = () => {
      const n = state.keys.length + 1;
      if (state.keys.length) state.revoked.push(state.keys.at(-1)!);
      state.keys.push(`rbk_${String(n).repeat(40)}`); state.credentials.push(`rbc_${String(n).repeat(64)}`);
      return { ...provisioning, connector: { ...provisioning.connector, credential: state.credentials.at(-1)! },
        model: { ...provisioning.model, key: state.keys.at(-1)!, keyId: `rbkkey-0${n}` } };
    };
    const fetcher = vi.fn(async (url: any, init: any) => {
      const route = String(url).split("/api/installations/")[1];
      if (route === "redeem") {
        const body = JSON.parse(init.body);
        if (state.owner && (state.owner.id !== body.id || state.owner.token !== body.token)) return Response.json({ error: "used" }, { status: 409 });
        state.owner = { id: body.id, token: body.token };
        const grant = issue(); state.provisioned = true;
        if (state.loseNextReply) { state.loseNextReply = false; throw new Error("reply lost"); }
        return linked(body, { provisioning: grant });
      }
      const token = String(init.headers?.Authorization ?? "").replace(/^Bearer /, "");
      if (!state.owner || token !== state.owner.token) return Response.json({ error: "inactive" }, { status: 401 });
      const body = JSON.parse(init.body); state.reports.push(body);
      return Response.json(state.provisioned && body.needsProvisioning === true ? { ok: true, provisioning: issue() } : { ok: true });
    });
    return { state, fetch: fetcher as unknown as typeof fetch };
  };
  const managedDesk = (fetcher: typeof fetch, beforeSaveConfig?: () => void, beforeReadConfig?: () => void) => {
    const root = privateFixtureRoot(join(tmpdir(), "realbud-link-redeliver-")); roots.push(root);
    const hermesRoot = join(root, "hermes"), profile = join(hermesRoot, "profiles", "property");
    privateFixtureDirectory(profile); writePrivateFixtureFile(join(profile, "SOUL.md"), "# Fictional profile\n");
    const configs: any[] = [];
    let config = {} as AppConfig;
    const access = createWorkerModelAccess({ directory: root, key: Buffer.alloc(32, 9), hermesRoot,
      readConfig: () => { beforeReadConfig?.(); return config; },
      saveConfig: patch => { beforeSaveConfig?.(); configs.push(patch); config = { ...config, ...patch, composio: { ...config.composio, ...patch.composio } }; } });
    const app = createOfficeLink({ directory: root, appVersion: "fictional", fetch: fetcher, provisioning: access,
      report: async () => ({ appVersion: "fictional", workerVersion: null, workerReady: true }) });
    return { app, access, configs, root, hermesRoot };
  };

  it("recovers from a redeem reply lost after provisioning: the retry gets replaced keys and the lost ones stop working", async () => {
    const site = website(); site.state.loseNextReply = true;
    const desk = managedDesk(site.fetch);
    await expect(desk.app.link({ code, label: "Fictional desk" })).rejects.toThrow(/could not be reached/);
    expect(await desk.access.env()).toEqual({});
    // Same code, same id and token: the website redelivers instead of linking empty.
    await desk.app.link({ code, label: "Fictional desk" });
    expect(await desk.app.modelAccessEnv(desk.access.env)).toEqual({ REALBUD_MODEL_API_KEY: site.state.keys[1] });
    expect(desk.configs.at(-1).composio.managed.credential).toBe(site.state.credentials[1]);
    expect(site.state.revoked).toEqual([site.state.keys[0]]);
    expect((await desk.app.status())).toMatchObject({ state: "linked", provisioned: true });
    // A grant in force is never asked for again, so a check-in rotates nothing.
    await desk.app.report();
    expect(site.state.reports.at(-1).needsProvisioning).toBeUndefined();
    expect(site.state.keys).toHaveLength(2);
    // The check-in names the key in force by its id so the website can flag a
    // mismatch; the key itself never leaves this computer.
    expect(site.state.reports.at(-1).modelKeyId).toBe("rbkkey-02");
    expect(JSON.stringify(site.state.reports)).not.toContain(site.state.keys[1]);

    // Another computer holding the same code but its own id and token gets nothing.
    const other = managedDesk(site.fetch);
    await expect(other.app.link({ code, label: "Other desk" })).rejects.toThrow(/expired or already used/);
    expect(await other.access.env()).toEqual({});
    expect(site.state.keys).toHaveLength(2);
  });

  it("asks for redelivery on a check-in while it holds no grant, and stops asking once one is in force", async () => {
    const site = website();
    // Linked, but the reply this computer kept said nothing about provisioning
    // (for example a replay answered while the first attempt was still running).
    const original = site.fetch;
    const quiet = vi.fn(async (url: any, init: any) => {
      const reply = await (original as any)(url, init);
      if (!String(url).endsWith("redeem")) return reply;
      const { provisioning: _dropped, ...rest } = await reply.json();
      return Response.json(rest);
    }) as unknown as typeof fetch;
    const quietDesk = managedDesk(quiet);
    await quietDesk.app.link({ code, label: "Fictional desk" });
    expect(await quietDesk.access.env()).toEqual({});
    await quietDesk.app.report();
    expect(site.state.reports.at(-1).needsProvisioning).toBe(true);
    expect(site.state.reports.at(-1)).not.toHaveProperty("modelKeyId");
    expect(await quietDesk.app.modelAccessEnv(quietDesk.access.env)).toMatchObject({ REALBUD_MODEL_API_KEY: site.state.keys[1] });
    expect(site.state.revoked).toEqual([site.state.keys[0]]);
    await quietDesk.app.report();
    expect(site.state.reports.at(-1).needsProvisioning).toBeUndefined();
    expect(site.state.keys).toHaveLength(2);
  });

  it("reports no key id and asks for redelivery when the vault lost the key the records still name", async () => {
    const site = website(); const desk = managedDesk(site.fetch);
    await desk.app.link({ code, label: "Fictional desk" });
    rmSync(join(desk.root, "company-installation/private/worker-model-access.json"));
    expect(await desk.app.status()).toMatchObject({ provisioned: true, modelKey: "missing" });
    await desk.app.report();
    expect(site.state.reports.at(-1)).toMatchObject({ needsProvisioning: true });
    expect(site.state.reports.at(-1)).not.toHaveProperty("modelKeyId");
    expect(await desk.app.modelAccessEnv(desk.access.env)).toEqual({ REALBUD_MODEL_API_KEY: site.state.keys[1] });
    expect(await desk.app.status()).not.toHaveProperty("modelKey");
    await desk.app.report();
    expect(site.state.reports.at(-1)).toMatchObject({ modelKeyId: "rbkkey-02" });
    expect(site.state.reports.at(-1)).not.toHaveProperty("needsProvisioning");
    expect(site.state.keys).toHaveLength(2);
  });

  it("reports a key the AI service rejected without asking for another, and a revoked installation stays revoked", async () => {
    const site = website(); const desk = managedDesk(site.fetch);
    await desk.app.link({ code, label: "Fictional desk" });
    noteModelKeyAnswer("rbkkey-01", false);
    try {
      expect(await desk.app.status()).toMatchObject({ modelKey: "rejected" });
      await desk.app.report();
      expect(site.state.reports.at(-1)).toMatchObject({ modelKeyId: "rbkkey-01", modelKeyRejected: true });
      expect(site.state.reports.at(-1)).not.toHaveProperty("needsProvisioning");
      expect(site.state.keys).toHaveLength(1);
      // The office revoked this computer: the website refuses its token.
      site.state.owner = { id: "fictional-other", token: "fictional-other" };
      await desk.app.report();
      expect(await desk.app.status()).toMatchObject({ state: "revoked" });
      expect(await desk.app.modelAccessEnv(desk.access.env)).toEqual({});
      const reports = site.state.reports.length;
      await desk.app.report();
      expect(site.state.reports).toHaveLength(reports);
      expect(site.state.keys).toHaveLength(1);
    } finally { noteModelKeyAnswer("rbkkey-01", true); }
  });

  it("keeps requesting provisioning after a connector write failure instead of stranding a linked computer", async () => {
    const site = website();
    // The link is already approved, while service setup arrives on its next
    // report (the same delivery path used after browser approval).
    const fetcher = vi.fn(async (url: any, init: any) => {
      const reply = await site.fetch(url, init);
      if (!String(url).endsWith("redeem")) return reply;
      const { provisioning: _pending, ...rest } = await reply.json() as Record<string, unknown>;
      return Response.json(rest);
    }) as unknown as typeof fetch;
    let configNeedsRecovery = true;
    const desk = managedDesk(fetcher, () => { if (configNeedsRecovery) throw new ConfigRecoveryError(); });
    await desk.app.link({ code, label: "Fictional desk" });
    await expect(desk.app.report()).rejects.toMatchObject({ code: "config_recovery_required" });
    expect(await desk.app.status()).toMatchObject({ state: "linked", provisioned: false });
    expect(await desk.app.modelAccessEnv(desk.access.env)).toEqual({});
    expect(desk.configs).toEqual([]);

    configNeedsRecovery = false;
    await desk.app.report();
    expect(site.state.reports.at(-1).needsProvisioning).toBe(true);
    expect(await desk.app.status()).toMatchObject({ state: "linked", provisioned: true });
    expect(await desk.app.modelAccessEnv(desk.access.env)).toEqual({ REALBUD_MODEL_API_KEY: site.state.keys[2] });
    expect(desk.configs.at(-1).composio.managed.credential).toBe(site.state.credentials[2]);
    expect(site.state.revoked).toEqual(site.state.keys.slice(0, 2));
    await desk.app.report();
    expect(site.state.reports.at(-1).needsProvisioning).toBeUndefined();
    expect(site.state.keys).toHaveLength(3);
  });

  it("holds credential requests locally through a persistent recovery failure and resumes once repaired", async () => {
    const site = website();
    let rejectReports = false;
    const fetcher = vi.fn(async (url: any, init: any) => {
      if (String(url).endsWith("/report") && rejectReports) return Response.json({}, { status: 403 });
      const reply = await site.fetch(url, init);
      if (!String(url).endsWith("redeem")) return reply;
      const { provisioning: _pending, ...rest } = await reply.json() as Record<string, unknown>;
      return Response.json(rest);
    }) as unknown as typeof fetch;
    let blocked = false;
    const desk = managedDesk(fetcher, undefined, () => { if (blocked) throw new ConfigRecoveryError(); });
    await desk.app.link({ code, label: "Fictional approved desk" });
    expect(site.state.keys).toHaveLength(1);
    blocked = true;
    for (let attempt = 0; attempt < 3; attempt++) await expect(desk.app.report()).rejects.toMatchObject({ code: "service_provisioning_local_recovery" });
    expect(site.state.reports).toHaveLength(0);
    expect(site.state.keys).toHaveLength(1);
    expect(await desk.app.status()).toMatchObject({ state: "linked", provisioned: false, error: expect.stringContaining("need recovery") });

    blocked = false;
    await desk.app.report();
    expect(site.state.reports).toHaveLength(1);
    expect(site.state.keys).toHaveLength(2);
    expect(await desk.app.status()).toMatchObject({ state: "linked", provisioned: true });
    expect((await desk.app.status()).error).toBeUndefined();

    // Local recovery must not suppress the revocation report of a grant that
    // is already active. Cleanup may hold, but the link loses authority first.
    blocked = true; rejectReports = true;
    await expect(desk.app.report()).rejects.toMatchObject({ code: "config_recovery_required" });
    expect(await desk.app.status()).toMatchObject({ state: "revoked" });
    expect(await desk.app.modelAccessEnv(desk.access.env)).toEqual({});
  });

  it("checks local provisioning storage before redeem without exposing its raw error", async () => {
    const fetcher = vi.fn();
    const desk = managedDesk(fetcher, undefined, () => { throw new Error("fictional-private-storage-detail"); });
    await expect(desk.app.link({ code, label: "Fictional desk" })).rejects.toMatchObject({ code: "service_provisioning_local_recovery" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await desk.app.status()).toMatchObject({ state: "unlinked" });
    expect(JSON.stringify(await desk.app.status())).not.toContain("fictional-private-storage-detail");
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

  it("does not label a newly approved installation with the previous installation's withdrawal", async () => {
    const p = sink();
    const root = mkdtempSync(join(tmpdir(), "realbud-link-new-installation-")); roots.push(root);
    let revoked = false, provision = true, localBlocked = false;
    const app = createOfficeLink({ directory: root, appVersion: "fictional", provisioning: { ...p, preflight: async () => { if (localBlocked) throw new ConfigRecoveryError(); } },
      report: async () => ({ appVersion: "fictional", workerVersion: null, workerReady: false }),
      fetch: vi.fn(async (url: any, init: any) => String(url).endsWith("redeem")
        ? linked(JSON.parse(init.body), { provisioning: provision ? provisioning : { skipped: "no_platform_customer" } })
        : Response.json({}, { status: revoked ? 403 : 200 })) as any });
    await app.link({ code, label: "Fictional old desk" });
    const oldId = (await app.status()).id;
    revoked = true; await app.report();
    expect(await app.status()).toMatchObject({ id: oldId, state: "revoked", serviceWithdrawn: true });

    provision = false; revoked = false;
    await app.link({ code, label: "Fictional approved desk" });
    const current = await app.status();
    expect(current).toMatchObject({ state: "linked", provisioned: false, provisioningSkipped: "no_platform_customer" });
    expect(current.id).not.toBe(oldId);
    expect(current.serviceWithdrawn).toBeUndefined();
    expect(p.withdrawn).toHaveBeenLastCalledWith(current.id);
    // The old marker is retained; only its attribution changed.
    expect(await p.withdrawn(oldId)).toBe(true);
    expect(await p.withdrawn()).toBe(true);
    localBlocked = true;
    await expect(app.report()).rejects.toMatchObject({ code: "service_provisioning_local_recovery" });
    expect(await app.status()).toMatchObject({ id: current.id, state: "linked", provisioned: false, error: expect.stringContaining("need recovery") });
    expect((await app.status()).serviceWithdrawn).toBeUndefined();
  });

  it("preserves the link on config recovery refusal and completes a repaired disconnect after remote revocation", async () => {
    const p = sink();
    const root = mkdtempSync(join(tmpdir(), "realbud-link-")); roots.push(root);
    let revocations = 0;
    const app = createOfficeLink({ directory: root, appVersion: "0.1.19", provisioning: p,
      report: async () => ({ appVersion: "0.1.19", workerVersion: null, workerReady: true }),
      fetch: vi.fn(async (url: any, init: any) => {
        if (String(url).endsWith("redeem")) return linked(JSON.parse(init.body), { provisioning });
        expect(init.method).toBe("DELETE");
        return Response.json({}, { status: ++revocations === 1 ? 200 : 401 });
      }) as any });
    await app.link({ code, label: "Desk" });
    const file = join(root, "office-link/link.json");
    const originalBytes = readFileSync(file);
    const recovery = new ConfigRecoveryError();
    p.clear.mockRejectedValueOnce(recovery);

    await expect(app.disconnect()).rejects.toBe(recovery);
    expect(readFileSync(file)).toEqual(originalBytes);
    expect((await app.status()).state).toBe("linked");
    expect(p.clear).toHaveBeenCalledTimes(1);

    await app.disconnect();
    expect(revocations).toBe(2);
    expect(p.clear).toHaveBeenCalledTimes(2);
    expect(await app.status()).toEqual({ state: "unlinked", usage: { state: "not-linked" } });
  });

  it("blocks a fresh access object on a saved revoked link and retries failed withdrawal before reconciliation", async () => {
    const root = privateFixtureRoot(join(tmpdir(), "realbud-link-recovery-")); roots.push(root);
    const hermesRoot = join(root, "hermes"), profile = join(hermesRoot, "profiles", "property");
    privateFixtureDirectory(profile); writePrivateFixtureFile(join(profile, "SOUL.md"), "# Fictional profile\n");
    let configBlocked = false, reportCalls = 0;
    let config = {} as AppConfig;
    const make = () => {
      const access = createWorkerModelAccess({ directory: root, key: Buffer.alloc(32, 7), hermesRoot,
        readConfig: () => config,
        saveConfig: patch => { if (configBlocked) throw new ConfigRecoveryError(); config = { ...config, ...patch, composio: { ...config.composio, ...patch.composio } }; } });
      const reconcile = vi.fn(access.reconcile);
      const app = createOfficeLink({ directory: root, appVersion: "fictional", report: async () => ({ appVersion: "fictional", workerVersion: null, workerReady: false }),
        provisioning: { ...access, reconcile },
        fetch: vi.fn(async (url: any, init: any) => {
          if (String(url).endsWith("redeem")) return linked(JSON.parse(init.body), { provisioning });
          reportCalls++; return Response.json({}, { status: 403 });
        }) as any });
      return { access, app, reconcile };
    };
    const first = make();
    await first.app.link({ code, label: "Fictional desk" });
    expect(Object.keys(await first.app.modelAccessEnv(first.access.env))).toContain("REALBUD_MODEL_API_KEY");
    configBlocked = true;
    await expect(first.app.report()).rejects.toMatchObject({ code: "config_recovery_required" });
    expect(await first.access.env()).toEqual({});
    expect((await first.app.status()).state).toBe("revoked");

    // A new access object has no in-memory hold. The durable link must block
    // its boot-time vault read before any report or network request happens.
    const restarted = make(); setWorkerModelGrant({ state: "none" });
    const readEnv = vi.fn(restarted.access.env);
    expect(await restarted.app.modelAccessEnv(readEnv)).toEqual({});
    expect(readEnv).not.toHaveBeenCalled();
    configBlocked = false; await restarted.app.report();
    expect(restarted.reconcile).not.toHaveBeenCalled();
    expect(reportCalls).toBe(1);
    expect(await restarted.access.state()).toMatchObject({ provisioned: false, withdrawn: true });
    expect(await restarted.access.env()).toEqual({});
  });

  it.each(["config", "vault"] as const)("keeps a failed %s withdrawal durable through code/browser relink and restart, then recovers", async fault => {
    const root = privateFixtureRoot(join(tmpdir(), "realbud-relink-recovery-")); roots.push(root);
    const hermesRoot = join(root, "hermes"), profile = join(hermesRoot, "profiles", "property");
    privateFixtureDirectory(profile); writePrivateFixtureFile(join(profile, "SOUL.md"), "# Fictional profile\n");
    let config: AppConfig = {}, configBlocked = false, revoked = false, generation = 0;
    const calls: string[] = [];
    let browserId = "";
    const grantFor = (id: string) => ({ ...provisioning,
      service: { companyId: "office-a", hostInstallationId: id },
      model: { ...provisioning.model, keyId: `fixture-key-${++generation}`, key: `rbk_${String(generation).repeat(40)}` } });
    const fetcher = vi.fn(async (url: any, init: any) => {
      const route = String(url).split("/api/installations/")[1]; calls.push(route);
      const body = init.body ? JSON.parse(init.body) : undefined;
      if (route === "redeem") return linked(body, { provisioning: grantFor(body.id) });
      if (route === "report") return revoked ? Response.json({}, { status: 403 }) : Response.json({ provisioning: grantFor(browserId) });
      if (route === "link-requests") {
        browserId = body.id;
        return Response.json({ version: 1, purpose: "installation-link-issued", approvalUrl: `https://realbud.app/link/${"A".repeat(43)}`,
          displayCode: "ABCD-EFGH", expiresAt: new Date(Date.now() + 600_000).toISOString() });
      }
      if (route === "link-requests/status") return Response.json({ version: 1, purpose: "installation-link-status", state: "linked",
        companyId: "office-a", agencyLabel: "Synthetic Office", installationId: browserId });
      return Response.json({}, { status: 404 });
    }) as unknown as typeof fetch;
    const make = () => {
      const access = createWorkerModelAccess({ directory: root, key: Buffer.alloc(32, 7), hermesRoot, readConfig: () => config,
        saveConfig: patch => { if (configBlocked) throw new ConfigRecoveryError(); config = { ...config, ...patch, composio: { ...config.composio, ...patch.composio } }; } });
      const app = createOfficeLink({ directory: root, appVersion: "fictional", fetch: fetcher, provisioning: access,
        report: async () => ({ appVersion: "fictional", workerVersion: null, workerReady: false }) });
      return { access, app };
    };
    let desk = make();
    await desk.app.link({ code, label: "Fictional old desk" });
    const firstId = (await desk.app.status()).id;
    const vaultPath = join(root, "company-installation/private/worker-model-access.json");
    const vaultBytes = readFileSync(vaultPath);
    if (fault === "config") configBlocked = true;
    else writePrivateFixtureFile(vaultPath, "{damaged");
    revoked = true;
    await expect(desk.app.report()).rejects.toThrow();
    const linkPath = join(root, "office-link/link.json"), revokedBytes = readFileSync(linkPath);
    expect(JSON.parse(revokedBytes.toString()).revoked).toBe(true);
    const mutationCalls = () => calls.filter(route => route !== "usage");
    const before = mutationCalls();
    // Neither path may replace the only durable cleanup instruction, even
    // after its in-memory withdrawal hold has been lost in a process restart.
    for (const restart of [false, true]) {
      if (restart) desk = make();
      await expect(desk.app.link({ code, label: "New code desk" })).rejects.toThrow();
      await expect(desk.app.beginBrowserLink({ label: "New browser desk" })).rejects.toThrow();
      expect(readFileSync(linkPath)).toEqual(revokedBytes);
      expect(await desk.app.modelAccessEnv(desk.access.env)).toEqual({});
      expect(await desk.app.status()).toMatchObject({ state: "revoked", id: firstId });
    }
    expect(mutationCalls()).toEqual(before);
    expect(generation).toBe(1);

    configBlocked = false;
    if (fault === "vault") writePrivateFixtureFile(vaultPath, vaultBytes);
    revoked = false;
    // Exercise recovery through both entry points across the two failures.
    if (fault === "config") await desk.app.link({ code, label: "Repaired code desk" });
    else {
      await desk.app.beginBrowserLink({ label: "Repaired browser desk" });
      await desk.app.browserLinkStatus();
      // Background provisioning makes several private writes; each costs a Windows admission launch.
      await vi.waitFor(async () => expect((await desk.app.status()).provisioned).toBe(true), process.platform === "win32" ? { timeout: 30_000, interval: 100 } : undefined);
    }
    const current = await desk.app.status();
    expect(current).toMatchObject({ state: "linked", provisioned: true });
    expect(current.id).not.toBe(firstId);
    expect(await desk.access.active(firstId!)).toBe(false);
    expect(await desk.access.active(current.id!)).toBe(true);
    expect(generation).toBe(2);
    expect(await desk.app.modelAccessEnv(desk.access.env)).toEqual({ REALBUD_MODEL_API_KEY: `rbk_${"2".repeat(40)}` });
  });

  it("holds a restarted foreign grant before status, key resolution, or credential redelivery", async () => {
    const site = website(); const desk = managedDesk(site.fetch);
    await desk.app.link({ code, label: "Fictional old desk" });
    const file = join(desk.root, "office-link/link.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
    writePrivateFixtureFile(file, JSON.stringify({ ...saved, id, provisioned: true }));
    const access = createWorkerModelAccess({ directory: desk.root, hermesRoot: desk.hermesRoot, key: Buffer.alloc(32, 9),
      readConfig: () => desk.configs.at(-1), saveConfig: () => { throw new Error("foreign grant must not mutate settings"); } });
    const app = createOfficeLink({ directory: desk.root, appVersion: "fictional", fetch: site.fetch, provisioning: access,
      report: async () => ({ appVersion: "fictional", workerVersion: null, workerReady: false }) });
    expect(await app.status()).toMatchObject({ id, state: "linked", provisioned: false });
    const resolveEnv = vi.fn(access.env);
    expect(await app.modelAccessEnv(resolveEnv)).toEqual({});
    expect(resolveEnv).not.toHaveBeenCalled();
    await expect(app.report()).rejects.toMatchObject({ code: "service_provisioning_local_recovery" });
    expect(site.state.reports).toHaveLength(0);
    expect(site.state.keys).toHaveLength(1);
  });

  it("does not publish a vault read that finishes after disconnect and relinking", async () => {
    const { app } = fixture(vi.fn(async (url, init) => String(url).endsWith("redeem")
      ? linked(JSON.parse(String(init?.body))) : Response.json({})));
    const resolver = vi.fn(async () => ({ REALBUD_MODEL_API_KEY: "fictional-model-access" }));
    expect(await app.modelAccessEnv(resolver)).toEqual({});
    expect(resolver).not.toHaveBeenCalled();
    await app.link({ code, label: "Fictional desk" });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = app.modelAccessEnv(async () => { entered(); await gate; return { REALBUD_MODEL_API_KEY: "fictional-old-access" }; });
    await started;
    await app.disconnect(); await app.link({ code, label: "Fictional new desk" });
    release(); expect(await pending).toEqual({});
    expect(await app.modelAccessEnv(resolver)).toEqual({ REALBUD_MODEL_API_KEY: "fictional-model-access" });
  });

  it.skipIf(process.platform === "win32")("withdraws immediately even when the revoked-link write fails, and retries after repair", async () => {
    const root = mkdtempSync(join(tmpdir(), "realbud-link-write-failure-")); roots.push(root);
    const p = sink(), directory = join(root, "office-link");
    let breakDirectory = true;
    const app = createOfficeLink({ directory: root, appVersion: "fictional", provisioning: p,
      report: async () => ({ appVersion: "fictional", workerVersion: null, workerReady: false }),
      fetch: vi.fn(async (url: any, init: any) => {
        if (String(url).endsWith("redeem")) return linked(JSON.parse(init.body), { provisioning });
        if (breakDirectory) chmodSync(directory, 0o755);
        return Response.json({}, { status: 403 });
      }) as any });
    await app.link({ code, label: "Fictional desk" });
    const before = readFileSync(join(directory, "link.json"));
    await expect(app.report()).rejects.toThrow(/private data directory/);
    expect(p.withdraw).toHaveBeenCalledTimes(1);
    expect(await p.withdrawn()).toBe(true);
    expect(readFileSync(join(directory, "link.json"))).toEqual(before);
    chmodSync(directory, 0o700); breakDirectory = false;
    await app.report();
    expect((await app.status()).state).toBe("revoked");
    expect(p.withdraw).toHaveBeenCalledTimes(2);
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

  it("treats a stated skip as no provisioning and never blocks linking or reporting, and keeps the reason for the card", async () => {
    const { sink, app, create } = build({ provisioning: { skipped: "no_platform_customer" } }, () => ({ provisioning: { skipped: "service_not_entitled" } }));
    await app.link({ code, label: "Desk" });
    expect(await app.status()).toMatchObject({ state: "linked", provisioned: false, provisioningSkipped: "no_platform_customer" });
    await app.report();
    expect(sink.apply).not.toHaveBeenCalled();
    // The latest stated reason replaces the earlier one and survives a restart.
    expect(await app.status()).toMatchObject({ lastReportedAt: expect.any(String), provisioningSkipped: "service_not_entitled" });
    expect((await create().status()).provisioningSkipped).toBe("service_not_entitled");
    // A report reply with no provisioning key at all is equally uneventful.
    const plain = build({}, () => ({ ok: true }));
    await plain.app.link({ code, label: "Desk" });
    await plain.app.report();
    expect(plain.sink.apply).not.toHaveBeenCalled();
    expect((await plain.app.status()).provisioningSkipped).toBeUndefined();
  });

  it("keeps a reason the website has not withdrawn, never refuses a reason it does not know, and clears it once the grant arrives", async () => {
    let reply: unknown = { provisioning: { skipped: "provisioning_gateway_not_ready" } };
    const { sink, app, create } = build({ provisioning: { skipped: "modelvia_customer_not_ready" } }, () => reply);
    await app.link({ code, label: "Desk" });
    await app.report();
    expect((await app.status()).provisioningSkipped).toBe("provisioning_gateway_not_ready");
    // The website's gateway was unreachable this time: it says nothing, and the
    // last stated reason stands rather than vanishing.
    reply = { ok: true };
    await app.report();
    expect((await app.status()).provisioningSkipped).toBe("provisioning_gateway_not_ready");
    // A reason a newer website adds is kept verbatim; one that is not a reason at all is refused.
    reply = { provisioning: { skipped: "some_future_reason_2" } };
    await app.report();
    expect((await app.status()).provisioningSkipped).toBe("some_future_reason_2");
    reply = { provisioning: { skipped: "Not A Reason" } };
    await expect(app.report()).rejects.toThrow(/cannot accept/);
    // Support finished setup: the next check-in carries the grant, which is
    // applied once, and the reason is gone for good, including after a restart.
    reply = { provisioning };
    await app.report();
    expect(sink.apply).toHaveBeenCalledTimes(1);
    expect(await app.status()).toMatchObject({ provisioned: true });
    expect((await app.status()).provisioningSkipped).toBeUndefined();
    reply = { provisioning: { skipped: "provisioning_attempt_requires_review" } };
    await create().report();
    expect(sink.apply).toHaveBeenCalledTimes(1);
    expect((await create().status()).provisioningSkipped).toBeUndefined();
  });

  it("holds a saved link whose stated reason is damaged, and reads an older link without one as before", async () => {
    const { app, create } = build({ provisioning: { skipped: "no_platform_customer" } }, () => ({ ok: true }));
    await app.link({ code, label: "Desk" });
    const path = join(roots.at(-1)!, "office-link/link.json");
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.provisioningSkipped).toBe("no_platform_customer");
    const { provisioningSkipped: _reason, ...older } = saved;
    writeFileSync(path, JSON.stringify(older));
    expect(await create().status()).toMatchObject({ state: "linked", provisioned: false });
    expect((await create().status()).provisioningSkipped).toBeUndefined();
    writeFileSync(path, JSON.stringify({ ...saved, provisioningSkipped: { injected: true } }));
    await expect(create().status()).rejects.toThrow("The saved website link needs recovery.");
  });

  it("waits long enough for the website's provisioning chain on redeem and report, and no longer on plain reads", async () => {
    const timeouts = vi.spyOn(AbortSignal, "timeout");
    try {
      const { app } = build({ provisioning }, () => ({ ok: true }));
      // Counts, not order: the status read after linking starts a background
      // usage read (10s) that may begin before or after the report's request.
      const count = (ms: number) => timeouts.mock.calls.filter(call => call[0] === ms).length;
      await app.link({ code, label: "Desk" });
      expect(count(60_000)).toBe(1);
      await app.report();
      expect(count(60_000)).toBe(2);
      // A background usage read may finish before this one or be shared with it,
      // so plain reads are counted as "at least one", each with the short deadline.
      await app.usage();
      expect(count(60_000)).toBe(2);
      expect(count(10_000)).toBeGreaterThanOrEqual(1);
      const readsBefore = count(10_000);
      await app.disconnect();
      expect(count(60_000)).toBe(2);
      expect(count(10_000)).toBe(readsBefore + 1);
      expect(timeouts.mock.calls.every(call => call[0] === 60_000 || call[0] === 10_000)).toBe(true);
    } finally { timeouts.mockRestore(); }
  });

  it("refuses a report grant for another office rather than applying it", async () => {
    const { sink, app } = build({}, () => ({ provisioning: { ...provisioning, service: { companyId: "office-b", hostInstallationId: "h" } } }));
    await app.link({ code, label: "Desk" });
    await expect(app.report()).rejects.toThrow(/different office/);
    expect(sink.apply).not.toHaveBeenCalled();
  });
});

describe("AI usage for the current month", () => {
  // It is October in Brisbane while still September in UTC. Keep fixtures
  // deterministic and assert the portal's accounting month, not the host's.
  const period = "2026-10";
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T14:30:00Z"));
  });
  afterEach(() => { vi.useRealTimers(); });
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

  it("reads a credit month, where credits exceed charges, as a negative net", () => {
    const usage = parseInstallationUsage(body({ money: { customerNetNanoAud: "-50000000000" } }), period);
    expect(formatNanoAud(usage.money.customerNetNanoAud)).toBe("-A$50.00");
    expect(formatCustomerCharge(usage.money.customerNetNanoAud)).toBe("A$50.00 credit");
    expect(() => parseInstallationUsage(body({ tokens: { input: "-1", output: "0" } }), period)).toThrow();
  });

  it("explicitly refreshes before the passive TTL and coalesces concurrent checks", async () => {
    let requests = 0, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { app: link } = fixture(vi.fn(async (url, init) => {
      if (String(url).endsWith("redeem")) return linked(init);
      const count = ++requests;
      if (count === 2) await gate;
      return Response.json(body({ requests: count }));
    }));
    await link.link({ code, label: "Fictional usage desk" });
    expect(await link.usage()).toMatchObject({ usage: { requests: 1 } });
    const refresh = link.refreshUsage(), concurrent = link.refreshUsage();
    await vi.waitFor(() => expect(requests).toBe(2));
    expect((await link.status()).usage).toMatchObject({ usage: { requests: 1 } });
    release();
    for (const result of await Promise.all([refresh, concurrent])) expect(result.usage).toMatchObject({ usage: { requests: 2 } });
    // Repeated clicks share a short cooldown; normal polls retain the 30s TTL.
    await link.refreshUsage(); expect(requests).toBe(2);
    vi.setSystemTime(new Date("2026-09-30T14:30:03Z"));
    expect((await link.refreshUsage()).usage).toMatchObject({ usage: { requests: 3 } });
    expect(requests).toBe(3);
  });

  it("explicit refresh can recover a cached unavailable result without waiting thirty seconds", async () => {
    let unavailable = true;
    const { link, calls } = app(() => unavailable ? Response.json({}, { status: 403 }) : Response.json(body()));
    await link.link({ code, label: "Fictional usage desk" });
    expect(await link.usage()).toEqual({ state: "unavailable" });
    unavailable = false;
    expect((await link.refreshUsage()).usage).toMatchObject({ state: "ready" });
    expect(calls.filter(url => url.includes("usage"))).toHaveLength(2);
  });

  it("does not expose or cache a prior office's delayed usage after the installation changes", async () => {
    let office = "a", release!: () => void, entered!: () => void, currentCalls = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const { app: link } = fixture(vi.fn(async (url, init) => {
      if (String(url).endsWith("redeem")) return Response.json({ installationId: JSON.parse(String(init?.body)).id, companyId: `fictional-${office}`, agencyLabel: `Fictional ${office}` });
      if (init?.method === "DELETE") return Response.json({});
      const owner = office;
      if (owner === "a") { entered(); await gate; } else currentCalls++;
      return Response.json(body({ requests: owner === "a" ? 111 : 222 }));
    }));
    await link.link({ code, label: "Fictional A" });
    const oldUsage = link.usage(); await started;
    await link.disconnect(); await link.status();
    office = "b"; await link.link({ code, label: "Fictional B" });
    // The old request cannot suppress this new installation's own refresh.
    expect(await link.usage()).toMatchObject({ state: "ready", usage: { requests: 222 } });
    release(); expect(await oldUsage).toEqual({ state: "checking" });
    expect(await link.status()).toMatchObject({ agencyLabel: "Fictional b", usage: { state: "ready", usage: { requests: 222 } } });
    expect(currentCalls).toBe(1);
  });

  it("does not reuse completed cached usage after direct disconnect and relinking", async () => {
    let requests = 0;
    const { link } = app(() => Response.json(body({ requests: ++requests })));
    await link.link({ code, label: "Fictional A" });
    expect(await link.usage()).toMatchObject({ usage: { requests: 1 } });
    await link.disconnect(); const beforeNewUsage = requests;
    await link.link({ code, label: "Fictional B" });
    expect(await link.usage()).toMatchObject({ usage: { requests: beforeNewUsage + 1 } });
  });

  it("asks once per 30 seconds, sends the bearer token, and never persists the figures", async () => {
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

  it("refreshes after 30 seconds and serves the cached figures before then", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));
      let requests = 0;
      const { link, calls } = app(() => Response.json(body({ period: "2026-09", requests: ++requests })));
      await link.link({ code, label: "Desk" });
      expect(await link.usage()).toMatchObject({ state: "ready", usage: { requests: 1 } });
      vi.setSystemTime(new Date("2026-09-15T12:00:29Z"));
      expect(await link.usage()).toMatchObject({ usage: { requests: 1 } });
      expect(calls.filter(url => url.includes("usage"))).toHaveLength(1);
      vi.setSystemTime(new Date("2026-09-15T12:00:30Z"));
      expect(await link.usage()).toMatchObject({ usage: { requests: 2 } });
      expect(calls.filter(url => url.includes("usage"))).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  it("refreshes at the Brisbane month boundary even while the previous month is cached", async () => {
    vi.setSystemTime(new Date("2026-09-30T13:59:59Z"));
    let replyPeriod = "2026-09", requests = 0;
    const { link, calls } = app(() => Response.json(body({ period: replyPeriod, requests: ++requests })));
    await link.link({ code, label: "Desk" });
    expect(await link.usage()).toMatchObject({ state: "ready", usage: { period: "2026-09", requests: 1 } });
    vi.setSystemTime(new Date("2026-09-30T14:00:00Z"));
    replyPeriod = "2026-10";
    expect(await link.usage()).toMatchObject({ state: "ready", usage: { period: "2026-10", requests: 2 } });
    expect((await link.status()).usage).toMatchObject({ state: "ready", usage: { period: "2026-10", requests: 2 } });
    expect(calls.filter(url => url.includes("usage"))).toEqual([
      "https://realbud.app/api/installations/usage?period=2026-09",
      "https://realbud.app/api/installations/usage?period=2026-10",
    ]);
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
    // Each private write costs a Windows admission launch, so allow for several there.
    await vi.waitFor(async () => expect((await app.status()).provisioned).toBe(true), process.platform === "win32" ? { timeout: 30_000, interval: 100 } : undefined);
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
