/** Plain-language labels for tool ids shown on Ask. Raw ids stay in `title`. */

const STREET =
  /\b(?:\d+\/)?\d+[A-Za-z]?\s+[A-Z][A-Za-z']+(?:\s+[A-Z][A-Za-z']+)*\s+(?:St|Street|Rd|Road|Ave|Avenue|Dr|Drive|Ct|Court|Pl|Place|Cres|Crescent|Hwy|Highway|Pde|Parade|Tce|Terrace|Ln|Lane|Blvd|Boulevard|Way|Cl|Close)\b/;

const LABELED_PLACE =
  /\b(?:for|at|property|address|case)\s*[:#]\s*([^\n,;]{2,48})/i;

const ALIAS: Record<string, string> = {
  bud_connected_app_action: "reviewing Bud's connected-app action",
  read_file: "reading a file",
  read: "reading a file",
  write_file: "writing a file",
  write: "writing a file",
  edit: "writing a file",
  web_search: "searching the web",
  search: "searching the web",
  fetch: "reading a web page",
  http: "reading a web page",
  web_fetch: "reading a web page",
  webfetch: "reading a web page",
  shell: "running a command in the workroom",
  bash: "running a command in the workroom",
  terminal: "running a command in the workroom",
  browser: "using the bounded browser",
  computer: "using the bounded browser",
  todo: "organising the steps",
  todo_write: "updating the work plan",
  session_search: "finding previous work",
  session_search_tool: "finding previous work",
  session_read: "reading previous work",
  delegate_task: "checking part of the work in parallel",
  vision_analyze: "reading an image",
  image: "reading an image",
  execute_code: "calculating in the workroom",
};

function normalizeToolId(name: string): string {
  return name
    .trim()
    .replace(/^mcp__[^_]+__/, "")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

function tokens(id: string): string[] {
  return id.split(/[^a-z0-9]+/).filter(Boolean);
}

function humanise(id: string): string {
  return id.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

export function toolLabel(name: string): string {
  const id = normalizeToolId(name);
  if (!id) return "working";
  if (id.includes("desk")) return "reading the Desk book";
  const exact = ALIAS[id];
  if (exact) return exact;
  for (const token of tokens(id)) {
    const mapped = ALIAS[token];
    if (mapped) return mapped;
  }
  return humanise(id) || name;
}

export function approvalPlace(payload: string, knownAddresses: readonly string[] = []): string | null {
  const text = payload.trim();
  if (!text) return null;
  for (const address of knownAddresses) {
    const street = address.split(",")[0]?.trim() || address;
    if (street && text.includes(street)) return street;
    if (text.includes(address)) return street;
  }
  const street = text.match(STREET);
  if (street) return street[0].replace(/,/g, "").trim();
  const labeled = text.match(LABELED_PLACE);
  if (labeled) {
    const value = labeled[1]?.replace(/^[·•]\s*/, "").trim();
    if (value) return value.split(",")[0]?.trim() || value;
  }
  return null;
}

export function approvalHeadline(
  tool: string,
  payload: string,
  knownAddresses: readonly string[] = [],
): string {
  const action = toolLabel(tool);
  const place = approvalPlace(payload, knownAddresses);
  if (place) return `For ${place} · ${action}`;
  return action.charAt(0).toUpperCase() + action.slice(1);
}
