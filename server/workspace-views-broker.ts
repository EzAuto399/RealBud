// Bud's saved-view and Desk layout tools: the person changes their Desk by asking
// Bud, with no separate management screen. `views_list` is a read with no card.
// `desk_arrange` changes only this computer's Desk layout, so it applies at once
// with no card and Desk offers Undo. Every saved-view change shows RealBud's
// one-time review card first. All writes go through the saved-views service
// (`server/workspace-tabs.ts`) with its revision check, so an edit made elsewhere
// is a conflict, never overwritten. Every view and Desk layout is checked with
// the shared parser. Mounted per ACP session as a loopback MCP server.
import { randomUUID } from "node:crypto";
import {
  DESK_SECTION_LABELS, LOCKED_DESK_SECTIONS, MAX_WORKSPACE_TABS, WORKSPACE_VIEW_FILTERS, deskChangeSummary, parseDeskSections, parseWorkspaceTabs, parseWorkspaceTabsResponse,
  sameDeskSections, validWorkspaceRevision, type DeskSection, type WorkspaceTab, type WorkspaceTabs, type WorkspaceViewKind,
} from "../shared/workspace-tabs.ts";
import { startLoopbackToolServer, toolError, type LoopbackToolResult, type LoopbackToolServer } from "./web-research-broker.ts";

export const WORKSPACE_VIEWS_SERVER = "workspace-views";
export const VIEWS_CONFLICT = "Your views changed — ask again";
export const DESK_CONFLICT = "Desk changed since you read it. Nothing was changed. Call views_list again, then retry desk_arrange with the new revision.";

/** The saved-views service as the host binds it for one turn: the same GET and
 * PUT the Desk uses (`createWorkspaceTabsHandler`), so the UI's next read sees
 * the change. Answers are the handler's `{ status, body }`. */
export interface BudWorkspaceViews {
  read(): Promise<{ status: number; body: unknown }>;
  save(body: { expectedRevision: number; version: 2; tabs: WorkspaceTab[]; desk: { sections: DeskSection[] } }): Promise<{ status: number; body: unknown }>;
}
export interface WorkspaceViewsReceipt { tool: string; outcome: "succeeded" | "failed" | "refused" | "declined" | "conflict"; viewId?: string }

const KIND_LABELS: Record<WorkspaceViewKind, string> = { tasks: "Tasks", bills: "Bills", jobs: "Saved jobs", "shared-work": "Shared work", mail: "Mail" };
const KINDS = Object.keys(WORKSPACE_VIEW_FILTERS) as WorkspaceViewKind[];
const ID = { type: "string", pattern: "^view-[a-z0-9-]{1,64}$" };
const NAME = { type: "string", minLength: 1, maxLength: 40 };
const SECTIONS = {
  type: "array",
  description: "The whole Desk layout in display order: every section exactly once as {id, visible}. 'queue' (Needs you) must stay visible.",
  items: { type: "object", additionalProperties: false, required: ["id", "visible"], properties: {
    id: { type: "string", enum: Object.keys(DESK_SECTION_LABELS) }, visible: { type: "boolean" } } },
};
const TOOLS = [
  { name: "views_list", description: "List the person's saved views (id, name, kind, filter, shown in the sidebar or hidden) and this computer's Desk layout: its revision, every section in display order with its name and whether it shows, and the sections that always show. Read only; call it before desk_arrange.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} } },
  { name: "desk_arrange", description: "Show, hide or reorder this computer's Desk sections. revision is the Desk revision views_list returned; sections lists every section id exactly once in display order. 'queue' (Needs you) always stays visible. Changes only this computer's view, applies at once with no card, and the person can Undo it. If Desk changed since views_list, read it again.",
    inputSchema: { type: "object", additionalProperties: false, required: ["revision", "sections"], properties: { revision: { type: "integer", minimum: 0 }, sections: SECTIONS } } },
  { name: "views_create", description: `Propose a new saved view in the sidebar. kind is one of ${KINDS.join(", ")}; filter is optional (defaults to the kind's first filter). The person approves it once on a card.`,
    inputSchema: { type: "object", additionalProperties: false, required: ["name", "kind"], properties: {
      name: NAME, kind: { type: "string", enum: KINDS }, filter: { type: "string", maxLength: 40 } } } },
  { name: "views_rename", description: "Propose renaming a saved view. The person approves it once on a card.",
    inputSchema: { type: "object", additionalProperties: false, required: ["id", "name"], properties: { id: ID, name: NAME } } },
  { name: "views_set_visible", description: "Propose showing or hiding a saved view in the sidebar. The person approves it once on a card.",
    inputSchema: { type: "object", additionalProperties: false, required: ["id", "visible"], properties: { id: ID, visible: { type: "boolean" } } } },
  { name: "views_reorder", description: "Propose a new order for the saved views. ids must list every saved view exactly once. The person approves it once on a card.",
    inputSchema: { type: "object", additionalProperties: false, required: ["ids"], properties: { ids: { type: "array", maxItems: MAX_WORKSPACE_TABS, items: ID } } } },
  { name: "views_delete", description: "Propose deleting a saved view. Business records are unchanged. The person approves it once on a card.",
    inputSchema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: ID } } },
];
const ARGS: Record<string, { required: string[]; optional: string[] }> = {
  views_list: { required: [], optional: [] },
  desk_arrange: { required: ["revision", "sections"], optional: [] },
  views_create: { required: ["name", "kind"], optional: ["filter"] },
  views_rename: { required: ["id", "name"], optional: [] },
  views_set_visible: { required: ["id", "visible"], optional: [] },
  views_reorder: { required: ["ids"], optional: [] },
  views_delete: { required: ["id"], optional: [] },
};

const text = (value: string, structuredContent?: Record<string, unknown>): LoopbackToolResult => ({ content: [{ type: "text", text: value }], ...(structuredContent ? { structuredContent } : {}) });
const quoted = (label: string) => `'${label}'`;
const sectionList = (sections: DeskSection[]) => sections.filter(section => section.visible).map(section => DESK_SECTION_LABELS[section.id]).join(", ");

/** A proposed change: the new state's tabs and layout, and its one-line card. */
type Change = { tabs: WorkspaceTab[]; sections: DeskSection[]; card: string; done: string; viewId?: string; result?: Record<string, unknown> };

/** desk_arrange: the whole layout, checked by the shared parser. The service's PUT always saves revision + 1. */
function arrangement(args: Record<string, unknown>, state: WorkspaceTabs): Change | string {
  if (!validWorkspaceRevision(args.revision)) return "revision must be the Desk revision views_list returned. Nothing was changed.";
  let sections: DeskSection[];
  try { sections = parseDeskSections(args.sections); } catch (error) { return `${error instanceof Error ? error.message : "Check the Desk sections."} Nothing was changed.`; }
  const revision = state.revision + 1;
  return { tabs: state.tabs, sections, card: "", result: { revision, previousRevision: state.revision },
    done: `Arranged Desk: ${deskChangeSummary(state.desk.sections, sections)}. Desk now shows ${sectionList(sections)}. The person can Undo it on Desk (previous revision ${state.revision}, now ${revision}).` };
}

function proposal(name: string, args: Record<string, unknown>, state: WorkspaceTabs): Change | string {
  const tabs = state.tabs, sections = state.desk.sections;
  const find = (id: unknown) => tabs.find(tab => tab.id === id);
  if (name === "views_create") {
    if (typeof args.kind !== "string" || !Object.hasOwn(WORKSPACE_VIEW_FILTERS, args.kind)) return `Choose a saved view kind: ${KINDS.join(", ")}. No views were changed.`;
    const kind = args.kind as WorkspaceViewKind, filters = WORKSPACE_VIEW_FILTERS[kind] as readonly string[];
    const filter = args.filter === undefined ? filters[0]! : args.filter;
    if (typeof filter !== "string" || !filters.includes(filter)) return `Choose a filter for ${KIND_LABELS[kind]}: ${filters.join(", ")}. No views were changed.`;
    if (tabs.length >= MAX_WORKSPACE_TABS) return `There are already ${MAX_WORKSPACE_TABS} saved views. Delete one before adding another.`;
    const tab: WorkspaceTab = { id: `view-${randomUUID()}`, label: typeof args.name === "string" ? args.name.trim() : "", visible: true, view: { kind, filter } };
    const filterText = filter === filters[0] ? "" : ` (${filter})`;
    return { tabs: [...tabs, tab], sections, card: `Create view ${quoted(tab.label)} with ${KIND_LABELS[kind]}${filterText}`, done: `Created view ${quoted(tab.label)}.`, viewId: tab.id };
  }
  if (name === "views_reorder") {
    const ids = args.ids;
    if (!Array.isArray(ids) || ids.length !== tabs.length || new Set(ids).size !== ids.length || ids.some(id => !find(id))) return "List every saved view id exactly once. Use views_list for the current ids. No views were changed.";
    const ordered = ids.map(id => find(id)!);
    if (ordered.every((tab, index) => tab === tabs[index])) return "The views are already in that order. Nothing was changed.";
    return { tabs: ordered, sections, card: `Reorder views: ${ordered.map(tab => quoted(tab.label)).join(", ")}`, done: "Reordered the saved views." };
  }
  const tab = find(args.id);
  if (!tab) return "That saved view was not found. Use views_list for the current ids. No views were changed.";
  if (name === "views_rename") {
    const label = typeof args.name === "string" ? args.name.trim() : "";
    if (label === tab.label) return `The view is already called ${quoted(label)}. Nothing was changed.`;
    return { tabs: tabs.map(row => row === tab ? { ...row, label } : row), sections, card: `Rename view ${quoted(tab.label)} to ${quoted(label)}`, done: `Renamed the view to ${quoted(label)}.`, viewId: tab.id };
  }
  if (name === "views_set_visible") {
    if (typeof args.visible !== "boolean") return "visible must be true or false. No views were changed.";
    if (args.visible === tab.visible) return `View ${quoted(tab.label)} is already ${tab.visible ? "shown" : "hidden"}. Nothing was changed.`;
    return { tabs: tabs.map(row => row === tab ? { ...row, visible: args.visible as boolean } : row), sections,
      card: `${args.visible ? "Show" : "Hide"} view ${quoted(tab.label)} ${args.visible ? "in" : "from"} the sidebar`, done: `${args.visible ? "Showed" : "Hid"} view ${quoted(tab.label)}.`, viewId: tab.id };
  }
  return { tabs: tabs.filter(row => row !== tab), sections, card: `Delete view ${quoted(tab.label)}`, done: `Deleted view ${quoted(tab.label)}. Business records are unchanged.`, viewId: tab.id };
}

const errorOf = (body: unknown) => {
  const value = body as { error?: unknown; code?: unknown } | null;
  return { message: typeof value?.error === "string" ? value.error : "Saved views could not be saved or checked. Nothing was changed.", code: typeof value?.code === "string" ? value.code : "" };
};

export async function startWorkspaceViewsBroker(options: {
  /** The current turn's id while it may still act, else null. */
  turnId(): string | null;
  /** The current turn's saved views, else undefined. */
  views(): BudWorkspaceViews | undefined;
  /** RealBud's one-time review card; true only for an explicit allow. */
  approve(summary: string, signal: AbortSignal): Promise<boolean>;
  receipt?: (receipt: WorkspaceViewsReceipt) => void;
}): Promise<LoopbackToolServer> {
  const note = (receipt: WorkspaceViewsReceipt) => { try { options.receipt?.(receipt); } catch { /* receipts never change the outcome */ } };
  const current = async (views: BudWorkspaceViews): Promise<WorkspaceTabs | string> => {
    const answer = await views.read();
    if (answer.status !== 200) return errorOf(answer.body).message;
    const parsed = parseWorkspaceTabsResponse(answer.body);
    return parsed.state ?? "Saved views need recovery before they can be changed. Your business records are unchanged.";
  };
  return startLoopbackToolServer({
    name: WORKSPACE_VIEWS_SERVER,
    serverName: "Bud saved views",
    tools: TOOLS,
    maxConcurrent: 1,
    isActive: () => options.turnId() !== null && options.views() !== undefined,
    async call(name, args, signal) {
      const turn = options.turnId(), views = options.views();
      if (!turn || !views) return toolError("Bud is no longer working on this request. Nothing was changed.");
      const shape = ARGS[name]!;
      if (Object.keys(args).some(key => !shape.required.includes(key) && !shape.optional.includes(key)) || shape.required.some(key => args[key] === undefined)) {
        return toolError(`${name} takes ${[...shape.required, ...shape.optional.map(key => `optional ${key}`)].join(", ") || "no arguments"}.`);
      }
      let state: WorkspaceTabs | string;
      try { state = await current(views); } catch { return toolError("Saved views could not be checked. Nothing was changed."); }
      if (typeof state === "string") return toolError(state);
      if (name === "views_list") {
        const rows = state.tabs.map(tab => ({ id: tab.id, name: tab.label, kind: tab.view.kind, filter: tab.view.filter, visible: tab.visible }));
        const lines = rows.map(row => `- ${row.id}: ${JSON.stringify(row.name)} (${KIND_LABELS[row.kind]}, ${row.filter}, ${row.visible ? "shown" : "hidden"})`);
        const desk = state.desk.sections.map(section => ({ id: section.id, name: DESK_SECTION_LABELS[section.id], visible: section.visible }));
        const deskLines = desk.map(section => `- ${section.id}: ${section.name} (${section.visible ? "shown" : "hidden"})`);
        return text(`${rows.length ? `Saved views:\n${lines.join("\n")}` : "There are no saved views yet."}\nDesk layout (revision ${state.revision}), in order:\n${deskLines.join("\n")}\nAlways shown: ${LOCKED_DESK_SECTIONS.join(", ")}.`,
          { views: rows, revision: state.revision, desk, locked: [...LOCKED_DESK_SECTIONS] });
      }
      const arranging = name === "desk_arrange";
      const change = arranging ? arrangement(args, state) : proposal(name, args, state);
      if (typeof change === "string") { note({ tool: name, outcome: "refused" }); return toolError(change); }
      if (arranging && args.revision !== state.revision) { note({ tool: name, outcome: "conflict" }); return toolError(DESK_CONFLICT); }
      if (arranging && sameDeskSections(change.sections, state.desk.sections)) return text("Desk already looks like that. Nothing was changed.");
      // The shared parser is the only judge of a valid set of views.
      try { parseWorkspaceTabs({ version: 2, revision: state.revision, tabs: change.tabs, desk: { sections: change.sections }, history: [] }); }
      catch { note({ tool: name, outcome: "refused" }); return toolError("Check the saved view name (1 to 40 plain characters), kind and filter. No views were changed."); }
      // A Desk layout changes only this computer's view and Desk offers Undo, so it has no card.
      if (!arranging && !await options.approve(change.card, signal)) {
        note({ tool: name, outcome: "declined" });
        return toolError("The person did not approve this change. No views were changed. Do not retry without a new request.");
      }
      if (signal.aborted || options.turnId() !== turn || options.views() !== views) return toolError("Bud is no longer working on this request. Nothing was changed.");
      try {
        // Compare-and-set on the revision read before the card was shown (or that Bud read for desk_arrange).
        const answer = await views.save({ expectedRevision: state.revision, version: 2, tabs: change.tabs, desk: { sections: change.sections } });
        if (answer.status === 200) {
          note({ tool: name, outcome: "succeeded", ...(change.viewId ? { viewId: change.viewId } : {}) });
          return text(change.done, change.viewId ? { viewId: change.viewId } : change.result);
        }
        const failure = errorOf(answer.body);
        if (answer.status === 409 && failure.code === "tabs_changed") { note({ tool: name, outcome: "conflict" }); return toolError(arranging ? DESK_CONFLICT : VIEWS_CONFLICT); }
        note({ tool: name, outcome: "failed" });
        return toolError(failure.message);
      } catch (error) {
        note({ tool: name, outcome: "failed" });
        const known = error instanceof Error && typeof (error as { code?: unknown }).code === "string";
        return toolError(known ? (error as Error).message : "Saved views could not be saved. Refresh Desk to check whether the change was kept.");
      }
    },
  });
}
