import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { cardSummary, decideDesktopAction, desktopCandidates, desktopSnapshot, hitTest, type DesktopFenceContext } from "./desktop-fence.ts";
import { CUA_NEVER_TOOLS } from "./cua-bounded.ts";
import type { BrowserTaskGrant } from "../shared/browser-task.ts";
import type { DesktopTarget } from "../shared/desktop-task.ts";

// ── ASSUMED RAW SHAPE (UNVERIFIED) ───────────────────────────────────────
// A get_window_state result as the pinned 0.34.0 driver is assumed to return
// it, built from `cua-driver describe get_window_state` and the binary's field
// names, not from a live capture. P2: replace with a real capture of a
// fictional window and confirm: role spelling ("AXButton"), how a secure field
// shows (role or subrole "AXSecureTextField"), whether `enabled`/`focused`
// exist, whether `frame` is screen points, and `window_bounds` + `screenshot_scale`.
const el = (index: number, role: string, label: string, frame: [number, number, number, number], extra: Record<string, unknown> = {}) => ({
  element_index: index, element_token: `s0000002a:${index}`, role, label, frame: { x: frame[0], y: frame[1], w: frame[2], h: frame[3] },
  parent_index: index === 0 ? null : 0, depth: index === 0 ? 0 : 1, ...extra,
});
export const ASSUMED_RAW_0_34 = {
  structuredContent: {
    snapshot_id: "s0000002a", window_title: "Re: lease renewal", app_name: "Mail",
    window_bounds: { x: 100, y: 50, w: 800, h: 600 }, screenshot_scale: 2, screenshot_frame_valid: true,
    element_count: 17, truncated: false, elements_complete: true,
    elements: [
      el(0, "AXWindow", "Re: lease renewal", [100, 50, 800, 600]),
      { ...el(1, "AXStaticText", "", [110, 52, 120, 10]), value: "Fictional Office" },
      el(2, "AXButton", "Send", [110, 60, 60, 20]),
      el(3, "AXButton", "Save", [180, 60, 60, 20]),
      el(4, "AXButton", "Sign in", [250, 60, 60, 20]),
      { ...el(5, "AXSecureTextField", "Mailbox passphrase", [110, 90, 200, 20]), value: "fictional-not-a-secret" },
      el(6, "AXTextField", "Subject", [110, 120, 400, 20], { focused: true }),
      el(7, "AXRow", "Re: lease renewal", [110, 150, 700, 20]),
      el(8, "AXLink", "Help", [110, 180, 40, 20]),
      el(9, "AXButton", "", [160, 180, 20, 20]),
      el(10, "AXGroup", "Toolbar", [100, 55, 800, 30]),
      el(11, "AXRadioButton", "Inbox", [110, 210, 60, 20], { subrole: "AXTabButton" }),
      el(12, "AXTextField", "BSB", [110, 240, 100, 20]),
      el(13, "AXButton", "Archive", [220, 240, 60, 20], { enabled: false }),
      el(14, "AXButton", "Delete", [290, 240, 60, 20]),
      el(15, "AXButton", "Pay rent now", [360, 240, 60, 20]),
      el(16, "AXTextField", "Notes", [110, 270, 300, 20]),
    ],
  },
};

const target = (): DesktopTarget => ({ appName: "Mail", bundleId: "com.apple.mail", pid: 4242, windowId: 7001, title: "Re: lease renewal" });
const grant = (extra: Partial<BrowserTaskGrant> = {}): BrowserTaskGrant => ({
  version: 1, purpose: "browser-task-grant", id: "grant-fictional-1", runId: "run-fictional-1", route: "ask",
  request: { text: "Archive the fictional lease email", sha256: "a".repeat(64) }, sites: [],
  browser: { id: null, accountMarker: "Fictional Office" }, actions: ["read", "click", "fill", "keys"],
  consequential: "ask-each", uploads: [], expiresAt: 2_000, budget: 10, desktop: target(), ...extra,
});
const ctx = (extra: Partial<DesktopFenceContext> = {}): DesktopFenceContext => ({
  grant: grant(), now: 1_000, used: 0, stopped: false, windows: [target()], snapshot: desktopSnapshot(ASSUMED_RAW_0_34), ...extra,
});
const at = { pid: 4242, window_id: 7001 };
const token = (index: number) => `s0000002a:${index}`;
const decide = (tool: string, args: Record<string, unknown> = {}, extra: Partial<DesktopFenceContext> = {}) => decideDesktopAction(ctx(extra), { tool, args: { ...at, ...args } });

describe("desktopSnapshot", () => {
  it("normalises the assumed 0.34 shape", () => {
    const snapshot = desktopSnapshot(ASSUMED_RAW_0_34);
    expect(snapshot).toMatchObject({ truncated: false, complete: true, window: { x: 100, y: 50, scale: 2 } });
    expect(snapshot.elements[2]).toEqual({ token: token(2), label: "Send", role: "button", secure: false, frame: { x: 110, y: 60, w: 60, h: 20 }, enabled: true, focused: false, parent: 0 });
    expect(snapshot.elements[1].label).toBe("Fictional Office");
    expect(snapshot.elements[5]).toMatchObject({ role: "secure text field", secure: true, label: "Mailbox passphrase" });
    expect(JSON.stringify(snapshot)).not.toContain("fictional-not-a-secret");
    expect(snapshot.elements[11].role).toBe("tab");
    expect(snapshot.elements[13].enabled).toBe(false);
  });

  it("never reads a truncated, degraded, filtered or unreadable tree as complete", () => {
    const sc = ASSUMED_RAW_0_34.structuredContent;
    for (const raw of [{ ...sc, truncated: true }, { ...sc, elements_complete: false }, { ...sc, degraded_reason: "ax_window_unresolved" },
      { ...sc, filtered_element_count: 3 }, { ...sc, elements: [...sc.elements, "junk"] }, null, { elements: "none" }]) {
      expect(desktopSnapshot(raw).complete).toBe(false);
    }
    expect(desktopSnapshot(null)).toEqual({ elements: [], truncated: true, complete: false });
  });
});

// A real cua-driver 0.22.1 get_window_state (Calculator, ids renumbered, max_elements 40).
const REAL_0_22 = JSON.parse(readFileSync(new URL("./testing/fixtures/cua-0.22.1-calculator-window-state.json", import.meta.url), "utf8"));
const calc = (): DesktopTarget => ({ appName: "Calculator", bundleId: "com.apple.calculator", pid: 1001, windowId: 2001, title: "Calculator" });

describe("desktopSnapshot: real 0.22.1 capture", () => {
  const snapshot = desktopSnapshot(REAL_0_22);
  it("reads its elements, keeps the tree text, and never calls a truncated read complete", () => {
    expect(snapshot).toMatchObject({ truncated: true, complete: false });
    expect(snapshot.window).toBeUndefined();
    expect(snapshot.elements.find(row => row.token === "s00000001:1")).toEqual({ token: "s00000001:1", label: "Delete", role: "button", secure: false,
      frame: { x: 1280, y: 852, w: 48, h: 48 }, enabled: true, focused: false, parent: 0 });
    expect(snapshot.text).toContain('AXStaticText = "0"');
  });

  it("marks the system menu bar, including an item whose parent the truncated read dropped, and never offers or presses it", () => {
    const menu = snapshot.elements.filter(row => row.menuBar).map(row => row.label || row.role);
    expect(menu).toEqual(["menu bar", "Apple", "About This Mac"]);
    expect(snapshot.elements.filter(row => !row.menuBar).every(row => row.role !== "menu item")).toBe(true);
    const labels = desktopCandidates(snapshot, "about this mac").map(row => row.label);
    expect(labels).toEqual(["Delete", "All Clear", "Add", "Equals", "Show Sidebar"]);
    const real = { ...ctx(), grant: grant({ desktop: calc(), browser: { id: null, accountMarker: null } }), windows: [calc()], snapshot };
    expect(decideDesktopAction(real, { tool: "click", args: { pid: 1001, window_id: 2001, element_token: "s00000001:29" } }))
      .toEqual({ decision: "deny", reason: "Bud does not use the system menu bar. Use a control inside the window." });
    expect(decideDesktopAction(real, { tool: "click", args: { pid: 1001, window_id: 2001, element_token: "s00000001:20" } }).decision).toBe("allow");
  });

  it("checks the account against the tree text, where 0.22 puts plain text", () => {
    const real = (marker: string) => ({ ...ctx(), grant: grant({ desktop: calc(), browser: { id: null, accountMarker: marker } }), windows: [calc()], snapshot });
    const read = { tool: "get_window_state", args: { pid: 1001, window_id: 2001 } };
    // The display's "0" is an AXStaticText value, present only in tree_markdown.
    expect(decideDesktopAction(real("0"), read).decision).toBe("allow");
    // Missing from a truncated read: asks, never concludes absence.
    expect(decideDesktopAction(real("Fictional Office"), read).decision).toBe("ask");
  });
});

describe("desktopCandidates", () => {
  it("offers labelled, enabled, actionable controls only, goal words first", () => {
    const list = desktopCandidates(desktopSnapshot(ASSUMED_RAW_0_34), "Open the lease renewal email and add notes");
    expect(list.slice(0, 2)).toEqual([{ token: token(7), label: "Re: lease renewal", role: "row" }, { token: token(16), label: "Notes", role: "text field" }]);
    const labels = list.map(row => row.label);
    for (const dropped of ["Mailbox passphrase", "Sign in", "BSB", "Archive", "", "Toolbar", "Fictional Office"]) expect(labels).not.toContain(dropped);
    expect(labels).toEqual(expect.arrayContaining(["Send", "Save", "Help", "Inbox", "Subject", "Delete", "Pay rent now"]));
    expect(Object.keys(list[0])).toEqual(["token", "label", "role"]);
  });

  it("drops credential-shaped labels and caps the list at 64", () => {
    const many = Array.from({ length: 80 }, (_, i) => el(i + 1, "AXButton", `Folder ${i}`, [0, 0, 1, 1]));
    const raw = { elements: [...many, el(90, "AXButton", "Bearer abcdefghijklmnopqrstuvwxyz012345", [0, 0, 1, 1]), el(91, "AXTextField", "One-time code", [0, 0, 1, 1])], truncated: false };
    const list = desktopCandidates(desktopSnapshot(raw), "");
    expect(list).toHaveLength(64);
    expect(list[0].label).toBe("Folder 0");
    expect(desktopCandidates(desktopSnapshot({ elements: raw.elements.slice(80) }), "code")).toEqual([]);
  });
});

describe("hitTest", () => {
  const snapshot = desktopSnapshot(ASSUMED_RAW_0_34);
  it("maps window pixels to the smallest element holding the point", () => {
    // Send's frame (110,60) is window pixel ((110-100)*2, (60-50)*2) = (20,20); the toolbar group also holds it.
    expect(hitTest(snapshot, 30, 30)?.label).toBe("Send");
    expect(hitTest(snapshot, 1500, 1100)?.role).toBe("window");
    expect(hitTest(snapshot, 5000, 5000)).toBeNull();
  });
  it("refuses to guess without the window's bounds", () => {
    expect(hitTest({ ...snapshot, window: undefined }, 30, 30)).toBeNull();
  });
});

describe("decideDesktopAction: every call", () => {
  it.each([
    ["Stop", { stopped: true }, "end"],
    ["an expired grant", { now: 2_000 }, "end"],
    ["a spent budget", { used: 10 }, "end"],
    ["a closed window", { windows: [] }, "end"],
    ["a reused pid", { windows: [{ ...target(), pid: 9999 }] }, "end"],
    ["a changed bundle", { windows: [{ ...target(), bundleId: "com.example.other" }] }, "end"],
    ["a grant without a window", { grant: grant({ desktop: undefined }) }, "deny"],
  ] as const)("%s → %s", (_name, extra, decision) => {
    expect(decide("get_window_state", {}, extra as Partial<DesktopFenceContext>).decision).toBe(decision);
  });

  it("works only in the granted window, and asks once to adopt another window of the same app", () => {
    expect(decide("click", { element_token: token(8), pid: 5555 }).decision).toBe("deny");
    expect(decide("click", { element_token: token(8), window_id: 9 }).decision).toBe("deny");
    expect(decide("get_window_state", { window_id: undefined }).decision).toBe("deny");
    const adopt = decide("get_window_state", { window_id: 7002 }, { windows: [target(), { ...target(), windowId: 7002, title: "New Message" }] });
    expect(adopt).toEqual({ decision: "ask", reason: 'Bud wants to work in another window of Mail, "New Message". It asks once.' });
    expect(decideDesktopAction(ctx(), { tool: "click", args: { target: { kind: "window", ...at }, element_token: token(8) } }).decision).toBe("allow");
  });

  it.each([...CUA_NEVER_TOOLS, "invoke_menu", "set_value", "drag", "browser_click", "browser_navigate", "escalate_session", "hotkey", "double_click", "launch_app", "mcp__cua-driver__set_value"])("denies %s", tool => {
    expect(decide(tool).decision).toBe("deny");
  });
});

describe("decideDesktopAction: reading and the account", () => {
  it("allows reading and scrolling", () => {
    expect(decide("get_window_state").decision).toBe("allow");
    expect(decide("mcp__cua-driver__scroll", { direction: "down" }).decision).toBe("allow");
    expect(decide("get_window_state", {}, { snapshot: null }).decision).toBe("allow");
    expect(decide("click", { element_token: token(8) }, { snapshot: null })).toMatchObject({ decision: "deny", reason: expect.stringContaining("Read the window again") });
  });

  it("ends when a whole tree lacks the account, and never concludes absence from a truncated one", () => {
    const without = { ...ASSUMED_RAW_0_34.structuredContent, elements: ASSUMED_RAW_0_34.structuredContent.elements.filter(row => row.element_index !== 1) };
    expect(decide("scroll", {}, { snapshot: desktopSnapshot(without) }).decision).toBe("end");
    for (const tool of ["get_window_state", "scroll", "click"]) {
      expect(decide(tool, { element_token: tool === "click" ? token(8) : undefined }, { snapshot: desktopSnapshot({ ...without, truncated: true }) }).decision).toBe("ask");
    }
    expect(decide("scroll", {}, { grant: grant({ browser: { id: null, accountMarker: null } }), snapshot: desktopSnapshot(without) }).decision).toBe("allow");
  });
});

describe("decideDesktopAction: click", () => {
  it.each([
    [2, "card", "send"], [14, "card", "delete"], [15, "card", "pay"],
    // Save asks once: the window's other buttons (Send, Delete, Pay rent now) never make it a card.
    [3, "ask", undefined], [4, "deny", undefined], [5, "deny", undefined], [12, "deny", undefined],
    [7, "allow", undefined], [8, "allow", undefined], [11, "allow", undefined],
    [9, "ask", undefined], [10, "ask", undefined], [16, "ask", undefined],
  ] as const)("element %i → %s", (index, decision, kind) => {
    const result = decide("click", { element_token: token(index) });
    expect(result.decision).toBe(decision);
    expect(result.kind).toBe(kind);
  });

  // A sheet (index 20) inside a window that also has Delete and Pay buttons: OK inside it reads the sheet alone.
  const plainGrant = grant({ browser: { id: null, accountMarker: null } });
  const sheet = (words: string, container: Record<string, unknown> = { role: "AXSheet" }, text?: string) => desktopSnapshot({ elements_complete: true,
    ...(text === undefined ? {} : { tree_markdown: text }),
    elements: [el(0, "AXWindow", "Fictional ledger", [100, 50, 800, 600]), el(1, "AXButton", "Delete", [110, 60, 60, 20]), el(2, "AXButton", "Pay rent now", [180, 60, 60, 20]),
      el(3, "AXButton", "Save", [250, 60, 60, 20]),
      { ...el(20, "AXSheet", "", [200, 100, 400, 200]), ...container },
      ...(words ? [{ ...el(21, "AXStaticText", "", [210, 110, 300, 20]), value: words, parent_index: 20 }] : []),
      { ...el(22, "AXButton", "OK", [500, 250, 60, 20]), parent_index: 20 }] });
  const ok = (snapshot: ReturnType<typeof sheet>, index = 22) => decide("click", { element_token: token(index) }, { grant: plainGrant, snapshot });
  it("asks once for Save in a window that merely also has Delete and Pay buttons", () => {
    expect(ok(sheet("Rename file?"), 3)).toEqual({ decision: "ask", reason: "Bud asks before pressing 'Save', once." });
  });
  it.each([
    ["Pay 12 bills, $8,400?", "pay"], ["Move 3 items to the Trash?", "delete"], ["Empty the Trash? You can't undo this.", "delete"],
    ["Discard changes to this draft?", "delete"], ["Send this message to 2 people?", "send"], ["Sign the fictional lease", "sign"],
  ] as const)("cards OK in a sheet that says %j, naming its kind", (words, kind) => {
    const result = ok(sheet(words));
    expect(result).toMatchObject({ decision: "card", kind });
    expect(result.reason).toMatch(/^Press 'OK' \(button\) in Mail — window "Re: lease renewal"\. The dialog mentions /);
  });
  it("asks once for OK in a sheet that is not consequential, whatever the rest of the window holds", () => {
    expect(ok(sheet("Rename file?"))).toEqual({ decision: "ask", reason: "Bud asks before pressing 'OK', once." });
    expect(ok(sheet("Rename file?", { role: "AXGroup" }))).toMatchObject({ decision: "ask" }); // not a dialog: never a card from the window
    expect(ok(sheet("Pay 12 bills, $8,400?", { role: "AXGroup" }))).toMatchObject({ decision: "ask" });
    expect(ok(sheet("Delete this file? You can Cancel.", { role: "AXGroup" }))).toMatchObject({ decision: "ask" });
  });
  it("finds the dialog by subrole or as a window inside the window, and reads its tree text lines", () => {
    expect(ok(sheet("Pay 12 bills, $8,400?", { role: "AXWindow", subrole: "AXDialog" }))).toMatchObject({ decision: "card", kind: "pay" });
    expect(ok(sheet("Send 3 messages?", { role: "AXWindow", subrole: "AXSystemDialog" }))).toMatchObject({ decision: "card", kind: "send" });
    expect(ok(sheet("Send 3 messages?", { role: "Window", subrole: "" }))).toMatchObject({ decision: "card", kind: "send" }); // UIA child window
    const text = `- [0] AXWindow "Fictional ledger"\n  - [1] AXButton (Delete)\n  - [20] AXSheet\n    - AXStaticText = "Pay 12 bills, $8,400?"\n    - [22] AXButton (OK)\n  - AXStaticText = "Send all"`;
    expect(ok(sheet("", { role: "AXSheet" }, text))).toMatchObject({ decision: "card", kind: "pay" });
    // Text below the sheet's lines (and the window's Delete button) never counts.
    expect(ok(sheet("", { role: "AXSheet" }, text.replace("Pay 12 bills, $8,400?", "Rename file?")))).toMatchObject({ decision: "ask" });
  });
  it("cards this fence's own delete words on a control", () => {
    for (const label of ["Move to Trash", "Empty Trash", "Discard", "Erase"]) {
      const snapshot = desktopSnapshot({ elements: [el(1, "AXButton", label, [0, 0, 1, 1])] });
      expect(decide("click", { element_token: token(1) }, { grant: plainGrant, snapshot })).toMatchObject({ decision: "card", kind: "delete" });
    }
  });

  it("cards a click anywhere inside a consequential control, under its real name", () => {
    // An icon (unlabelled) and a caption (labelled) inside "Delete", which sits in a toolbar group.
    const raw = { ...ASSUMED_RAW_0_34.structuredContent, elements: [...ASSUMED_RAW_0_34.structuredContent.elements,
      { ...el(17, "AXImage", "", [292, 242, 16, 16]), parent_index: 14 }, { ...el(18, "AXStaticText", "Invoice 12", [362, 242, 40, 16]), parent_index: 15 },
      { ...el(19, "AXImage", "", [112, 182, 10, 10]), parent_index: 8 }] };
    const snapshot = desktopSnapshot(raw);
    // Window pixel of screen (300,250): ((300-100)*2, (250-50)*2).
    expect(decide("click", { x: 400, y: 400 }, { snapshot })).toMatchObject({ decision: "card", kind: "delete", reason: expect.stringContaining("'Delete' (button)") });
    expect(decide("click", { x: 540, y: 400 }, { snapshot })).toMatchObject({ decision: "card", kind: "pay", reason: expect.stringContaining("'Pay rent now' (button)") });
    expect(decide("click", { element_token: token(17) }, { snapshot })).toMatchObject({ decision: "card", kind: "delete", reason: expect.stringContaining("'Delete'") });
    expect(decide("press_key", { key: "return", element_token: token(17) }, { snapshot })).toMatchObject({ decision: "card", kind: "delete" });
    // An unlabelled icon inside the Help link is classified as Help; a labelled control is itself.
    expect(decide("click", { element_token: token(19) }, { snapshot })).toEqual({ decision: "allow", reason: "Press 'Help' (link)." });
    // A named control pressed by its token is that control (static text: Bud asks once).
    expect(decide("click", { element_token: token(18) }, { snapshot })).toEqual({ decision: "ask", reason: "Bud could not tell what this control does. It asks once." });
    // The window itself is never the surrounding that names a click.
    expect(decide("click", { x: 1500, y: 1100 }, { snapshot }).decision).toBe("ask");
  });

  it("keeps an unnamed control itself: an icon-only button inside a named row asks, never borrows the row's name", () => {
    const raw = { ...ASSUMED_RAW_0_34.structuredContent, elements: [...ASSUMED_RAW_0_34.structuredContent.elements,
      el(30, "AXRow", "Invoice 12", [110, 400, 700, 20]), { ...el(31, "AXButton", "", [780, 402, 16, 16]), parent_index: 30 }] };
    const snapshot = desktopSnapshot(raw);
    const asks = { decision: "ask", reason: "Bud could not tell what this control does. It asks once." };
    expect(decide("click", { element_token: token(31) }, { snapshot })).toEqual(asks);
    expect(decide("press_key", { key: "return", element_token: token(31) }, { snapshot })).toEqual(asks);
    // Window pixel of screen (788,410): ((788-100)*2, (410-50)*2).
    expect(decide("click", { x: 1376, y: 720 }, { snapshot })).toEqual(asks);
  });

  it("refuses a click that carries both a token and a point", () => {
    expect(decide("click", { element_token: token(8), x: 30, y: 30 })).toEqual({ decision: "deny", reason: "Click a control by its element_token or by a point, not both." });
    expect(decide("click", { element_token: token(8), y: 0 }).decision).toBe("deny");
  });

  it("allows a point only on a whole tree, onto a named control; otherwise it asks once", () => {
    // Help link (110,180) is window pixel (30,270).
    expect(decide("click", { x: 30, y: 270 })).toEqual({ decision: "allow", reason: "Press 'Help' (link)." });
    const partial = desktopSnapshot({ ...ASSUMED_RAW_0_34.structuredContent, truncated: true });
    expect(decide("click", { x: 30, y: 270 }, { snapshot: partial, grant: grant({ browser: { id: null, accountMarker: null } }) }))
      .toEqual({ decision: "ask", reason: "Bud wants to click a point it could not fully check in the window. It asks once." });
    // An unnamed icon inside Help: named by Help for a token, but a point onto it asks.
    const icon = desktopSnapshot({ ...ASSUMED_RAW_0_34.structuredContent, elements: [...ASSUMED_RAW_0_34.structuredContent.elements, { ...el(32, "AXImage", "", [112, 182, 10, 10]), parent_index: 8 }] });
    expect(decide("click", { x: 30, y: 270 }, { snapshot: icon }).decision).toBe("ask");
    expect(decide("click", { element_token: token(32) }, { snapshot: icon }).decision).toBe("allow");
    // A consequential hit is still its card, complete or not.
    expect(decide("click", { x: 30, y: 30 }, { snapshot: partial, grant: grant({ browser: { id: null, accountMarker: null } }) })).toMatchObject({ decision: "card", kind: "send" });
  });

  it("asks before a navigation click when the grant may not click", () => {
    expect(decide("click", { element_token: token(8) }, { grant: grant({ actions: ["read"] }) }).decision).toBe("ask");
  });

  it("refuses a stale token", () => {
    expect(decide("click", { element_token: "s0000001f:8" })).toMatchObject({ decision: "deny", reason: expect.stringContaining("Read the window again") });
    expect(decide("click", { element_token: 8 }).decision).toBe("deny");
  });

  it("classifies a point by what it hits", () => {
    expect(decide("click", { x: 30, y: 30 })).toMatchObject({ decision: "card", kind: "send" });
    expect(decide("click", { x: 5000, y: 5000 })).toEqual({ decision: "ask", reason: "Bud wants to click an unlabelled point in the window. It asks once." });
    expect(decide("click", {}).decision).toBe("deny");
  });

  it("asks before a modified or non-left click", () => {
    for (const extra of [{ modifier: ["cmd"] }, { modifiers: "shift" }, { button: "right" }, { action: "show_menu" }]) {
      expect(decide("click", { element_token: token(8), ...extra }).decision).toBe("ask");
    }
  });
});

describe("decideDesktopAction: typing and keys", () => {
  it("types only into a named, ordinary field", () => {
    expect(decide("type_text", { element_token: token(16), text: "Fictional note" }).decision).toBe("allow");
    expect(decide("type_text", { text: "Fictional note" }).decision).toBe("deny");
    expect(decide("type_text", { element_token: token(5), text: "x" }).decision).toBe("deny");
    expect(decide("type_text", { element_token: token(12), text: "000000" }).decision).toBe("deny");
    expect(decide("type_text", { element_token: token(16), text: "sk-ant-fictional0123456789abcdef" }).decision).toBe("deny");
    expect(decide("type_text", { element_token: token(16), text: "x" }, { grant: grant({ actions: ["read", "click"] }) }).decision).toBe("ask");
  });

  it("asks once before typing a line break, and refuses one in a consequential field", () => {
    for (const text of ["Fictional note\n", "line one\r\nline two", "x\r"]) {
      expect(decide("type_text", { element_token: token(16), text })).toEqual({ decision: "ask", reason: "Bud wants to type a line break, which can submit or send. It asks once." });
    }
    const send = desktopSnapshot({ elements: [el(1, "AXTextField", "Send to", [0, 0, 1, 1])] });
    expect(decide("type_text", { element_token: token(1), text: "fictional@example.com\n" }, { grant: grant({ browser: { id: null, accountMarker: null } }), snapshot: send }).decision).toBe("deny");
  });

  it("allows navigation keys, classifies Return by its element, and asks for modifiers", () => {
    for (const key of ["Tab", "escape", "ArrowDown", "pageup", "Page_Down"]) expect(decide("press_key", { key }).decision).toBe("allow");
    expect(decide("press_key", { key: "tab", modifiers: ["cmd"] }).decision).toBe("ask");
    expect(decide("press_key", { key: "return", element_token: token(2) })).toMatchObject({ decision: "card", kind: "send" });
    expect(decide("press_key", { key: "return", element_token: token(3) }).decision).toBe("ask");
    expect(decide("press_key", { key: "return", element_token: token(4) }).decision).toBe("deny");
    // The focused Subject field: a text field, so Return asks once.
    expect(decide("press_key", { key: "return" }).decision).toBe("ask");
    const unfocused = desktopSnapshot({ elements: [el(2, "AXButton", "Fictional Office", [0, 0, 1, 1])] });
    expect(decide("press_key", { key: "enter" }, { snapshot: unfocused }).reason).toBe("Bud could not tell what Return would press here. It asks once.");
    for (const key of ["delete", "space", "a"]) expect(decide("press_key", { key }).decision).toBe("deny");
  });
});

describe("cardSummary", () => {
  const snapshot = desktopSnapshot(ASSUMED_RAW_0_34);
  it("names the control, app, window and effect", () => {
    const card = cardSummary({ tool: "click" }, snapshot.elements[2], "Mail", "Re: lease renewal", "com.apple.mail");
    expect(card.summary).toBe(`Press 'Send' (button) in Mail — window "Re: lease renewal". This sends a message. Once only.`);
    expect(card.details).toEqual(["App: Mail (com.apple.mail)", 'Control: button "Send"', "Bud could not confirm the amount or recipient in this app; check the window."]);
    expect(cardSummary({ tool: "press_key" }, snapshot.elements[14], "Mail", "", "com.apple.mail").summary)
      .toBe("Press Return on 'Delete' (button) in Mail — untitled window. This deletes something. Once only.");
  });

  it("flags long or disguised names and redacts secrets", () => {
    const long = { ...snapshot.elements[2], label: `Send ${"x".repeat(80)}` };
    const card = cardSummary({ tool: "click" }, long, "Mail", "Inbox", "com.apple.mail");
    expect(card.summary).toContain("…' (button)");
    expect(card.details).toContain("Its name has more text than the control shows.");
    expect(cardSummary({ tool: "click" }, { ...long, label: "Se​nd" }, "Mail", "Inbox", "com.apple.mail").details).toContain("Its name has more text than the control shows.");
    const secret = cardSummary({ tool: "click" }, { ...long, label: "Send token=fictionalvalue123" }, "Mail", "Inbox", "com.apple.mail");
    expect(JSON.stringify(secret)).not.toContain("fictionalvalue123");
  });
});
