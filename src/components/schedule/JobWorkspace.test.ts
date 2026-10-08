import { isValidElement, type ReactElement, type ReactNode, type SetStateAction } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobRun, Recipe } from "@/lib/desk";
import { EMPTY_JOB_DRAFT, jobPlanFields, type JobDraftState } from "@/lib/job-plan";
import { manualJobRequestKey } from "../../../shared/manual-job-request";
import { api } from "@/state/store";
import { JobWorkspace, timingIssue } from "./JobWorkspace";
import { PortalJobActions } from "./PortalJobActions";
import { JobRunFeed } from "../desk/JobRunFeed";

const fixture = vi.hoisted(() => ({ cursor: 0, values: [] as unknown[], preview: null as string | null,
  state: { connected: true, jobDraftBusy: false, jobDraft: null as unknown as JobDraftState, jobRuns: [] as JobRun[], desk: null, config: null, serviceAdmin: null, hermes: null, scheduleRecovery: { active: false, detail: "" } },
  recipes: [] as Recipe[], dispatch: vi.fn(), onRecipes: vi.fn(), onRefresh: vi.fn(), onDeleted: vi.fn() }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useEffect: () => {}, useRef: <T,>(value: T) => ({ current: value }),
  useState: <T,>(initial: T) => { const index = fixture.cursor++; if (!(index in fixture.values)) fixture.values[index] = initial;
    return [fixture.values[index] as T, (next: SetStateAction<T>) => { fixture.values[index] = typeof next === "function" ? (next as (value: T) => T)(fixture.values[index] as T) : next; }]; },
}));
vi.mock("@/state/store", () => ({ api: vi.fn(), useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }) }));
const access = vi.hoisted(() => ({ admin: true, link: "linked" as string | undefined, availability: vi.fn((..._args: unknown[]) => ({ ready: true })) }));
vi.mock("@/lib/use-service-admin-access", () => ({ useServiceAdminAccess: () => access.admin }));
vi.mock("@/lib/use-office-link", () => ({ useOfficeLinkRead: () => access.link }));
vi.mock("@/lib/bud-setup", () => ({ budAvailability: access.availability, budFacingCopy: (value: unknown, fallback: string) => value instanceof Error ? value.message : fallback }));
vi.mock("@/lib/design-preview", () => ({ get DESIGN_PREVIEW_REASON() { return fixture.preview; } }));
vi.mock("../desk/JobRunFeed", () => ({ JobRunFeed: () => null }));
vi.mock("./ExecutionHistory", () => ({ ExecutionHistory: () => null }));
vi.mock("./PortalJobActions", () => ({ PortalJobActions: () => null }));
const apps = vi.hoisted(() => ({ snapshot: null as unknown, open: vi.fn() }));
vi.mock("@/lib/connected-apps-refresh", () => ({ useOfficeSources: () => ({ snapshot: apps.snapshot }) }));
vi.mock("@/lib/workspace-setup", () => ({ openWorkspaceSetup: apps.open }));

const plan: Recipe = { id: "fictional-job", title: "Invoice questions", description: "Compare the supplied invoices.", steps: ["Read supplied invoices", "List questions for review"], allowedOrigins: [], evidence: "Source-linked questions", capabilities: ["read-files", "analyse", "draft"], limits: { maxRuntimeMinutes: 2, maxTurns: 6 }, status: "shadow", createdAt: 1, updatedAt: 1, revision: 2, approvedRevision: null, planApprovedAt: null, attachment: null, submitAcknowledgedAt: null, schedule: null };
const approved = (): Recipe => ({ ...plan, status: "active", planApprovedAt: 100, approvedRevision: plan.revision });
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement<Record<string, unknown>>(node)) return text(node.props.children as ReactNode);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function view() { fixture.cursor = 0; return JobWorkspace({ recipes: fixture.recipes, loading: false, loadError: "", onRecipes: fixture.onRecipes, onRefresh: fixture.onRefresh, onDeleted: fixture.onDeleted }); }
function button(name: string) { const found = elements(view()).find(node => node.type === "button" && text(node.props.children as ReactNode) === name); expect(found, name).toBeDefined(); return found!; }
async function click(name: string) { (button(name).props.onClick as () => void)(); await vi.waitFor(() => expect(fixture.state.jobDraftBusy).toBe(false)); }
function result(requestId: string): JobRun { return { id: "fictional-run", jobId: plan.id, jobTitle: plan.title, jobRevision: plan.revision, mode: "prepare", status: "completed", trigger: "manual", scheduledFor: 100, idempotencyKey: manualJobRequestKey(plan.id, plan.revision, "prepare", requestId), attempt: 1, spec: plan, evidence: [{ at: 100, kind: "output", note: "Fictional reviewed output" }], approvalRequests: [], detail: "Fictional preparation completed", createdAt: 100, finishedAt: 101 }; }
beforeEach(() => {
  fixture.values.length = 0; fixture.cursor = 0; fixture.preview = null;
  fixture.state.jobDraft = { text: plan.description, plan, fields: jobPlanFields(plan), saved: true };
  fixture.state.jobDraftBusy = false; fixture.state.jobRuns = []; fixture.recipes = [plan]; fixture.state.scheduleRecovery = { active: false, detail: "" }; fixture.onDeleted.mockReset();
  fixture.dispatch.mockReset().mockImplementation(action => {
    if (action.type === "jobDraft") fixture.state.jobDraft = action.draft;
    if (action.type === "jobDraftBusy") fixture.state.jobDraftBusy = action.busy;
    if (action.type === "jobRun") fixture.state.jobRuns = [action.run];
  });
  fixture.onRecipes.mockReset().mockImplementation(recipes => { fixture.recipes = recipes; });
  fixture.onRefresh.mockReset().mockResolvedValue(undefined); vi.mocked(api).mockReset(); apps.snapshot = null; apps.open.mockReset();
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) });
});
afterEach(() => vi.unstubAllGlobals());

describe("guided job trial", () => {
  it("approves the displayed unscheduled revision, then prepares once with a recoverable request and presents its result", async () => {
    vi.mocked(api).mockImplementation(async (path, options) => path.endsWith("/prepare") ? { run: result(JSON.parse(String(options?.body)).requestId) } : { recipes: [approved()] });
    const editor = elements(view()).find(node => node.type === "details" && text(node.props.children as ReactNode).includes("Edit job details"));
    expect(editor?.props.open).toBe(false);
    await click("Approve and try once");
    expect(api).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api).mock.calls.map(call => call[0])).toEqual(["/api/recipes/fictional-job", "/api/recipes/fictional-job/prepare"]);
    expect(JSON.parse(String(vi.mocked(api).mock.calls[0][1]?.body))).toEqual({ planApproved: true, status: "active", expectedRevision: 2 });
    expect(fixture.state.jobDraft.plan).toEqual(approved());
    expect(fixture.state.jobRuns[0].status).toBe("completed");
    expect(button("Review result").props.disabled).toBeUndefined();
  });

  it("never runs when the approval reply does not confirm the exact plan", async () => {
    vi.mocked(api).mockResolvedValue({ recipes: [{ ...approved(), revision: 3, approvedRevision: 3 }] });
    await click("Approve and try once");
    expect(api).toHaveBeenCalledTimes(1);
    expect(fixture.state.jobRuns).toEqual([]);
    expect(text(view())).toContain("no run was started");
  });

  it("recovers a lost run reply with the same request, without repeating plan approval or creating another attempt", async () => {
    let requestId = "";
    vi.mocked(api).mockImplementation(async (path, options) => {
      if (!path.endsWith("/prepare")) return { recipes: [approved()] };
      const incoming = JSON.parse(String(options?.body)).requestId as string;
      if (!requestId) { requestId = incoming; throw new Error("Fictional lost reply"); }
      expect(incoming).toBe(requestId); return { run: result(incoming) };
    });
    await click("Approve and try once");
    await click("Check previous run");
    expect(vi.mocked(api).mock.calls.map(call => call[0])).toEqual(["/api/recipes/fictional-job", "/api/recipes/fictional-job/prepare", "/api/recipes/fictional-job/prepare"]);
    expect(fixture.state.jobRuns).toHaveLength(1);
  });

  it("keeps website plan and site authority in its existing single control surface", () => {
    const portal: Recipe = { ...plan, capabilities: ["portal-read"], allowedOrigins: ["example.test"] };
    fixture.state.jobDraft = { text: portal.description, plan: portal, fields: jobPlanFields(portal), saved: true }; fixture.recipes = [portal];
    const nodes = elements(view());
    expect(nodes.filter(node => node.type === PortalJobActions)).toHaveLength(1);
    expect(nodes.filter(node => node.type === "button" && /Approve/.test(text(node.props.children as ReactNode)))).toEqual([]);
    expect(api).not.toHaveBeenCalled();
  });

  it("lets design-preview visitors write examples but blocks model execution even if a disabled handler is called", async () => {
    fixture.preview = "Fictional design preview limitation";
    expect(button("Approve and try once").props.disabled).toBe(true);
    await click("Approve and try once");
    fixture.state.jobDraft = EMPTY_JOB_DRAFT;
    expect(button("Morning priorities").props.disabled).toBe(false);
    (button("Morning priorities").props.onClick as () => void)();
    expect(fixture.state.jobDraft.text).toContain("inbox evidence supplied");
    expect(button("Suggest a job").props.disabled).toBe(true);
    await click("Suggest a job");
    expect(api).not.toHaveBeenCalled();
  });

  it("does not mount website mutation controls or actionable run results in design preview", () => {
    fixture.preview = "Fictional design preview limitation";
    const portal: Recipe = { ...plan, capabilities: ["portal-read"], allowedOrigins: ["example.test"] };
    fixture.state.jobDraft = { text: portal.description, plan: portal, fields: jobPlanFields(portal), saved: true }; fixture.recipes = [portal];
    const nodes = elements(view());
    expect(nodes.filter(node => node.type === PortalJobActions || node.type === JobRunFeed)).toEqual([]);
    expect(api).not.toHaveBeenCalled();
  });
});

describe("Bud availability on a job", () => {
  afterEach(() => { access.admin = true; access.link = "linked"; });
  it("reads this computer's office link, as Work does, so unlinked staff are told to connect it", () => {
    access.admin = false; access.link = "not-linked";
    view();
    expect(access.availability).toHaveBeenLastCalledWith(null, true, false, { canAdminister: false, officeLink: "not-linked" });
  });
});

describe("job detail actions", () => {
  it("improves steps through the existing operation and keeps the new version unapproved", async () => {
    fixture.state.jobDraft = { text: plan.description, plan: approved(), fields: jobPlanFields(approved()), saved: true }; fixture.recipes = [approved()];
    fixture.state.jobRuns = [result("fictional-request")];
    const improved: Recipe = { ...approved(), revision: 3, steps: ["Read supplied invoices once"] };
    vi.mocked(api).mockResolvedValue({ recipe: improved });
    await click("Improve steps");
    expect(vi.mocked(api).mock.calls.map(call => [call[0], call[1]?.method])).toEqual([["/api/recipes/fictional-job/distill", "POST"]]);
    expect(fixture.state.jobDraft.plan).toEqual(improved);
    expect(text(view())).toContain("approve the new plan");
  });

  it("deletes only after confirmation and closes the detail", async () => {
    fixture.state.jobDraft = { text: plan.description, plan: approved(), fields: jobPlanFields(approved()), saved: true }; fixture.recipes = [approved()];
    vi.mocked(api).mockResolvedValue({ recipes: [] });
    (button("Delete job").props.onClick as () => void)();
    expect(api).not.toHaveBeenCalled();
    await click("Confirm delete");
    expect(vi.mocked(api).mock.calls.map(call => [call[0], call[1]?.method])).toEqual([["/api/recipes/fictional-job", "DELETE"]]);
    expect(fixture.state.jobDraft).toEqual(EMPTY_JOB_DRAFT);
    expect(fixture.onDeleted).toHaveBeenCalledOnce();
  });

  it("holds approval and changes while scheduled work is in recovery", async () => {
    fixture.state.scheduleRecovery = { active: true, detail: "Fictional recovery" };
    expect(button("Approve and try once").props.disabled).toBe(true);
    expect(button("Delete job").props.disabled).toBe(true);
    await click("Approve and try once");
    expect(api).not.toHaveBeenCalled();
  });
});

type Handler = (event: unknown) => void;
function control(label: string): Element {
  const found = elements(view()).find(node => node.type === "label" && ([] as unknown[]).concat(node.props.children)[0] === label);
  expect(found, label).toBeDefined();
  return elements(found!.props.children as ReactNode).find(node => node.type === "input" || node.type === "select")!;
}
function open(job: Recipe) { fixture.state.jobDraft = { text: job.description, plan: job, fields: jobPlanFields(job), saved: true }; fixture.recipes = [job]; }
const daily = (): Recipe => ({ ...approved(), schedule: { time: "09:00", weekdays: [1, 2, 3, 4, 5] } });

describe("repeat timing", () => {
  it("saves a minute repeat with its window and days, then shows it in plain words", async () => {
    open(daily());
    (control("Repeat").props.onChange as Handler)({ target: { value: "minutes" } });
    expect(fixture.state.jobDraft.fields).toMatchObject({ everyMinutes: 15, until: "17:00", time: "09:00" });
    (control("Minutes between runs").props.onChange as Handler)({ target: { value: "2" } });
    expect(text(view())).toContain("Each run counts toward your office's monthly AI limit.");
    expect(button("Save changes").props.disabled).toBe(false);
    const schedule = { time: "09:00", weekdays: [1, 2, 3, 4, 5], everyMinutes: 2, until: "17:00" };
    vi.mocked(api).mockResolvedValue({ recipes: [{ ...daily(), revision: 3, approvedRevision: null, planApprovedAt: null, schedule }] });
    await click("Save changes");
    expect(JSON.parse(String(vi.mocked(api).mock.calls[0][1]?.body)).draft.schedule).toEqual(schedule);
    expect(text(view())).toContain("Every 2 minutes, 9:00 am–5:00 pm, weekdays");
  });

  it("counts hours as whole hours and returns to once a day without a window", () => {
    open(daily());
    (control("Repeat").props.onChange as Handler)({ target: { value: "hours" } });
    expect(control("Hours between runs").props.value).toBe(1);
    (control("Hours between runs").props.onChange as Handler)({ target: { value: "3" } });
    expect(fixture.state.jobDraft.fields?.everyMinutes).toBe(180);
    (control("Repeat").props.onChange as Handler)({ target: { value: "daily" } });
    expect(fixture.state.jobDraft.fields).toMatchObject({ everyMinutes: null, until: null });
    expect(text(view())).not.toContain("monthly AI limit");
    expect(control("Time").props.value).toBe("09:00");
  });

  it("shows each invalid value beside its field and keeps Save off with that reason", () => {
    open({ ...daily(), schedule: { time: "09:00", weekdays: [1, 2, 3, 4, 5], everyMinutes: 5, until: "17:00" } });
    (control("Minutes between runs").props.onChange as Handler)({ target: { value: "" } });
    let markup = text(view());
    expect(markup).toContain("Choose a whole number of minutes from 1 to 1440.");
    expect(markup).toContain("Fix the timing before saving: Choose a whole number of minutes from 1 to 1440.");
    expect(button("Save changes").props).toMatchObject({ disabled: true, "aria-describedby": "job-save-blocked" });
    expect(control("Minutes between runs").props).toMatchObject({ "aria-invalid": true, "aria-describedby": "job-timing-issue" });
    (control("Minutes between runs").props.onChange as Handler)({ target: { value: "1441" } });
    expect(button("Save changes").props.disabled).toBe(true);
    (control("Minutes between runs").props.onChange as Handler)({ target: { value: "10" } });
    (control("Until (optional)").props.onChange as Handler)({ target: { value: "08:00" } });
    markup = text(view());
    expect(markup).toContain("Until must be later than From.");
    expect(button("Save changes").props.disabled).toBe(true);
    (control("Until (optional)").props.onChange as Handler)({ target: { value: "" } });
    expect(fixture.state.jobDraft.fields?.until).toBeNull();
    expect(text(view())).toContain("Leave empty to repeat until midnight.");
    expect(button("Save changes").props.disabled).toBe(false);
    expect(timingIssue({ scheduled: true, time: "09:00", weekdays: [], everyMinutes: 10, until: null }, "minutes")?.message).toBe("Choose at least one day.");
    expect(timingIssue({ scheduled: true, time: "09:00", weekdays: [1], everyMinutes: 90, until: null }, "hours")?.message).toBe("Choose a whole number of hours from 1 to 24.");
    expect(timingIssue({ scheduled: true, time: "", weekdays: [1], everyMinutes: null, until: null }, "minutes")?.message).toBe("Choose a time.");
    expect(timingIssue({ scheduled: false, time: "", weekdays: [], everyMinutes: 0, until: null }, "minutes")).toBeNull();
  });
});

describe("mailbox ability", () => {
  const mailBox = () => elements(view()).find(node => node.type === "input" && node.props["aria-describedby"] === "job-read-mail-help")!;
  const status = (services: Record<string, unknown>) => ({ configured: true, checkedAt: "2026-10-08T00:00:00.000Z", services, tools: { available: true, names: [] } });

  it("labels the ability and explains it reads but never sends", () => {
    expect(mailBox().props.disabled).toBeUndefined();
    expect(text(view())).toContain("Read the reviewed mailbox");
    expect(text(view())).toContain("Bud reads your connected mailbox when this job runs; it never sends.");
    expect(text(view())).not.toContain("Connect your mailbox");
  });

  it("holds the ability with the fix beside it when the office has no connected mailbox", () => {
    apps.snapshot = status({});
    expect(mailBox().props.disabled).toBe(true);
    expect(text(view())).toContain("Connect your mailbox in Workspace → Connected apps first.");
    (button("Open connected apps").props.onClick as () => void)();
    expect(apps.open).toHaveBeenCalledWith("apps");
    open({ ...plan, capabilities: [...plan.capabilities, "read-mail"] });
    expect(mailBox().props.disabled).toBeUndefined();
  });

  it("allows the ability once a mailbox account is active", () => {
    apps.snapshot = status({ gmail: { connected: true, status: "ACTIVE", accounts: [{ id: "fictional-account", status: "ACTIVE" }], accountSelectionRequired: false } });
    expect(mailBox().props.disabled).toBeUndefined();
    expect(text(view())).not.toContain("Connect your mailbox");
  });
});

describe("stopping a run", () => {
  const running = (): JobRun => ({ ...result("fictional-request"), status: "running", finishedAt: undefined });
  beforeEach(() => { open(approved()); fixture.state.jobRuns = [running()]; });

  it("offers Stop now beside the run, even while another step is in flight, and shows Stopping… until it settles", async () => {
    fixture.state.jobDraftBusy = true;
    expect(button("Stop now").props.disabled).toBe(false);
    fixture.state.jobDraftBusy = false;
    let settle: (value: unknown) => void = () => {};
    vi.mocked(api).mockImplementation(() => new Promise(resolve => { settle = resolve; }));
    (button("Stop now").props.onClick as () => void)();
    expect(vi.mocked(api).mock.calls[0].slice(0, 2)).toEqual(["/api/loops/recipe-fictional-job/stop", { method: "POST" }]);
    expect(button("Stopping…").props.disabled).toBe(true);
    (button("Stopping…").props.onClick as () => void)();
    expect(api).toHaveBeenCalledTimes(1);
    settle({ run: { ...running(), status: "cancelled", finishedAt: 102 } });
    await vi.waitFor(() => expect(fixture.state.jobRuns[0].status).toBe("cancelled"));
    expect(elements(view()).some(node => node.type === "button" && /^Stop/.test(text(node.props.children as ReactNode)))).toBe(false);
  });

  it("shows the server's reason in place and lets the person try again", async () => {
    vi.mocked(api).mockRejectedValue(Object.assign(new Error("Fictional run is already finishing"), { status: 409 }));
    (button("Stop now").props.onClick as () => void)();
    await vi.waitFor(() => expect(text(view())).toContain("Fictional run is already finishing"));
    expect(button("Stop now").props).toMatchObject({ disabled: false, "aria-describedby": "job-stop-error" });
  });

  it("never calls a lost reply a failed stop", async () => {
    vi.mocked(api).mockRejectedValue(new Error("Fictional network drop"));
    (button("Stop now").props.onClick as () => void)();
    await vi.waitFor(() => expect(text(view())).toContain("The stop could not be confirmed. If this run still shows as running, press Stop now again."));
  });
});
