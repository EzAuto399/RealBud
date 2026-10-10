/** One calm line naming what Bud is doing while it uses a tool in an Ask turn
 * ("Reading the bank feed…"). Only the tool identifier at the head of a tool
 * start's title is read (Hermes ACP writes `<tool>` or `<tool>: <preview>`),
 * never its arguments. An unknown or missing tool gets no line, so the working
 * indicator keeps its plain "Working for Ns". */

/** RealBud's loopback tool servers by the name Hermes gives them (hyphens become
 * underscores), each with its tools' step lines. */
const SERVER_STEPS: Record<string, Record<string, string>> = {
  bank_source: {
    bank_accounts_list: "Checking the bank accounts…",
    bank_transactions_list: "Reading the bank feed…",
  },
  workroom: { workroom_read: "Looking through the office book…" },
  web_pages: { read_page: "Reading a web page…" },
  hermios_crm: {
    crm_search: "Searching Hermios…",
    search_hermios_mentions: "Searching Hermios…",
    crm_get_record: "Opening a Hermios record…",
    get_hermios_record: "Opening a Hermios record…",
    crm_set_stage: "Preparing a Hermios update…",
    crm_add_note: "Preparing a Hermios update…",
    crm_add_task: "Preparing a Hermios update…",
  },
  reminders: { set_reminder: "Setting a reminder…" },
  workspace_views: {
    views_list: "Checking your saved views…",
    desk_arrange: "Arranging your Desk…",
    views_create: "Preparing a change to your views…",
    views_rename: "Preparing a change to your views…",
    views_set_visible: "Preparing a change to your views…",
    views_reorder: "Preparing a change to your views…",
    views_delete: "Preparing a change to your views…",
  },
  workflow_settings: {
    workflow_settings_read: "Checking the working rules…",
    workflow_settings_propose: "Preparing a change to the working rules…",
    workflow_settings_restore: "Preparing a change to the working rules…",
    repeat_propose: "Preparing a repeat for your Schedule…",
  },
  decisions: { decide: "Weighing up the options…" },
  memory_proposals: { memory_propose: "Preparing a preference for you to review…" },
};

/** Connected apps (Composio, the office mailbox) and the office's added connectors. */
const APP_SERVERS = new Set(["connected_apps", "office_mail", "office_connectors"]);

/** The worker's own file and image readers, which carry no server prefix. */
const NATIVE_STEPS: Record<string, string> = {
  read_file: "Reading a file…",
  search_files: "Searching the files…",
  vision_analyze: "Looking at an image…",
  session_search: "Finding earlier work…",
};

const SERVERS = [...Object.keys(SERVER_STEPS), ...APP_SERVERS];
// The leading identifier, then the end or Hermes' ": " preview. A shell command
// ("ls -la") has no identifier and gets no line.
const HEAD = /^\s*([A-Za-z0-9_.-]{1,128})(?::|\s*$)/;

function appStep(tool: string): string {
  const slug = tool.toUpperCase();
  const mail = /^(GMAIL|OUTLOOK)_/.exec(slug)?.[1];
  if (!mail) return "Checking a connected app…";
  if (/_(?:SEND|REPLY|FORWARD)_|_(?:CREATE|UPDATE)_(?:EMAIL_)?DRAFT$/.test(slug)) return "Preparing an email…";
  return mail === "GMAIL" ? "Checking Gmail…" : "Checking Outlook…";
}

function split(id: string): { server: string | null; tool: string } | null {
  // mcp__<server>__<tool>; older releases wrote mcp_<server>_<tool>.
  const current = /^mcp__(.+?)__(.+)$/i.exec(id);
  if (current) return { server: current[1]!.toLowerCase().replace(/-/g, "_"), tool: current[2]! };
  if (/^mcp_/i.test(id)) {
    const rest = id.slice(4);
    const lower = rest.toLowerCase().replace(/-/g, "_");
    const server = SERVERS.find((name) => lower.startsWith(`${name}_`));
    return server ? { server, tool: rest.slice(server.length + 1) } : null;
  }
  return { server: null, tool: id };
}

/** The step line for a tool start's title or bare tool identifier, or null. */
export function askStepLabel(title: unknown): string | null {
  if (typeof title !== "string") return null;
  const id = HEAD.exec(title)?.[1];
  const parts = id ? split(id) : null;
  if (!parts || !parts.tool) return null;
  if (parts.server !== null) {
    if (APP_SERVERS.has(parts.server)) return appStep(parts.tool);
    return SERVER_STEPS[parts.server]?.[parts.tool.toLowerCase()] ?? null;
  }
  const tool = parts.tool.toLowerCase();
  if (NATIVE_STEPS[tool]) return NATIVE_STEPS[tool]!;
  for (const steps of Object.values(SERVER_STEPS)) if (steps[tool]) return steps[tool]!;
  return null;
}
