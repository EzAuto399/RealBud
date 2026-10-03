import { isValidElement, type ReactElement, type ReactNode, type SetStateAction } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobRun, Recipe } from "@/lib/desk";
import { EMPTY_JOB_DRAFT, jobPlanFields, type JobDraftState } from "@/lib/job-plan";
import { manualJobRequestKey } from "../../../shared/manual-job-request";
import { api } from "@/state/store";
import { JobWorkspace } from "./JobWorkspace";
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
vi.mock("@/lib/use-service-admin-access", () => ({ useServiceAdminAccess: () => true }));
vi.mock("@/lib/bud-setup", () => ({ budAvailability: () => ({ ready: true }), budFacingCopy: (value: unknown, fallback: string) => value instanceof Error ? value.message : fallback }));
vi.mock("@/lib/design-preview", () => ({ get DESIGN_PREVIEW_REASON() { return fixture.preview; } }));
vi.mock("../desk/JobRunFeed", () => ({ JobRunFeed: () => null }));
vi.mock("./ExecutionHistory", () => ({ ExecutionHistory: () => null }));
vi.mock("./PortalJobActions", () => ({ PortalJobActions: () => null }));

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
  fixture.onRefresh.mockReset().mockResolvedValue(undefined); vi.mocked(api).mockReset();
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
