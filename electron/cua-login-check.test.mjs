import { describe, expect, it, vi } from "vitest";
import { checkCuaLogin } from "./cua-login-check.mjs";
const binding = { pid: 123, windowId: 456, origin: "https://bank.example", accountMarker: "Office 41", readyMarker: "Transaction history" };
const bound = { status: "ok", binding_quality: "exact", target_id: "target1", tabs: [{ tab_id: "tab1", url: "https://bank.example/history" }] };
const snapshot = () => ({ status: "ok", target_id: "target1", tab_id: "tab1", page: { url: "https://bank.example/history" }, snapshot: { complete: true, format: "semantic_v2" }, refs: [], content_refs: ["Office 41", "Transaction history"].map(name => ({ name, visibility: "in_viewport", role: "heading" })) });
const driver = (state = snapshot(), bind = bound) => ({ callTool: vi.fn().mockResolvedValueOnce({ structuredJson: JSON.stringify(bind), isError: false }).mockResolvedValueOnce({ structuredJson: JSON.stringify(state), isError: false }) });
describe("pinned Cua sign-in readback", () => {
  it("uses two read-only calls, exact window binding, no screenshots and full visible account labels", async () => {
    const cua = driver(); expect(await checkCuaLogin(cua, binding, "test")).toBe(true);
    expect(cua.callTool.mock.calls.every(([name, args]) => name === "get_browser_state" && JSON.parse(args).include_screenshot === false)).toBe(true);
    expect(JSON.parse(cua.callTool.mock.calls[0][1])).toMatchObject({ pid: 123, window_id: 456, session: "test" });
  });
  it("refuses ambiguous tabs before inspecting account data", async () => {
    const cua = driver(snapshot(), { ...bound, tabs: [...bound.tabs, { tab_id: "tab2", url: "https://bank.example/other" }] });
    expect(await checkCuaLogin(cua, binding, "test")).toBe(false); expect(cua.callTool).toHaveBeenCalledTimes(1);
  });
  it.each(["prefix", "hidden", "partial", "wrong-site", "changed-tab", "login"])("refuses %s readback", async kind => {
    const state = snapshot();
    if (kind === "prefix") state.content_refs[0].name = "Office 410";
    if (kind === "hidden") state.content_refs[0].visibility = "offscreen";
    if (kind === "partial") state.snapshot.complete = false;
    if (kind === "wrong-site") state.page.url = "https://bank.example.evil/history";
    if (kind === "changed-tab") state.tab_id = "tab2";
    if (kind === "login") state.content_refs.push({ role: "textbox", name: "Verification code", visibility: "in_viewport" });
    expect(await checkCuaLogin(driver(state), binding, "test")).toBe(false);
  });
  it("rejects errors even if they echo expected labels", async () => {
    const cua = { callTool: async () => ({ isError: true, text: "Office 41 Transaction history" }) };
    await expect(checkCuaLogin(cua, binding, "test")).rejects.toThrow(/refused/);
  });
});
