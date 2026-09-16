/** Only a structured browser readback can satisfy a saved account binding.
 * Unknown driver output shapes fail closed; never search arbitrary raw JSON
 * (which could contain an error echoing the expected marker). */
export function decodeCuaToolResult(raw) {
  const result = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!result || result.isError || result.error || result.errorCode || result.degraded) throw new Error("browser check refused");
  if (typeof result.structuredJson === "string") return JSON.parse(result.structuredJson);
  if (result.structuredContent) return result.structuredContent;
  if (Array.isArray(result.content)) {
    const texts = result.content.filter(c => c.type === "text" && typeof c.text === "string");
    if (texts.length !== 1) throw new Error("unsupported browser readback");
    return JSON.parse(texts[0].text);
  }
  return result;
}

export async function checkCuaLogin(driver, binding, session) {
  const call = async args => decodeCuaToolResult(await driver.callTool("get_browser_state", JSON.stringify({ ...args, session, include_screenshot: false })));
  const bound = await call({ pid: binding.pid, window_id: binding.windowId });
  if (bound.status !== "ok" || bound.binding_quality !== "exact" || typeof bound.target_id !== "string" || !Array.isArray(bound.tabs)) return false;
  const matching = bound.tabs.filter(tab => {
    try { return typeof tab.tab_id === "string" && new URL(tab.url).origin === binding.origin; } catch { return false; }
  });
  // No guessing between multiple accounts/tabs, even on the same website.
  if (matching.length !== 1) return false;
  const snapshot = await call({ target_id: bound.target_id, tab_id: matching[0].tab_id, snapshot_format: "semantic_v2" });
  if (snapshot.target_id !== bound.target_id || snapshot.tab_id !== matching[0].tab_id) return false;
  try { if (new URL(snapshot.page?.url).origin !== binding.origin) return false; } catch { return false; }
  // Cua 0.19.3's observed semantic_v2 response. Only visible page labels can
  // prove the account; error text, titles, hidden nodes and partial snapshots
  // cannot. Match full labels so account 41 cannot match account 410.
  if (snapshot.status !== "ok" || snapshot.snapshot?.format !== "semantic_v2" || snapshot.snapshot?.complete !== true || !Array.isArray(snapshot.content_refs) || !Array.isArray(snapshot.refs)) return false;
  const nodes = [...snapshot.content_refs, ...snapshot.refs].filter(node => node.visibility === "in_viewport" && node.role !== "rootwebarea");
  const labels = nodes.filter(node => typeof node.name === "string").map(node => node.name.normalize("NFKC").trim());
  const text = labels.join("\n");
  if (/\b(password|one.time code|verification code|sign in to continue)\b/i.test(text)) return false;
  return [binding.accountMarker, binding.readyMarker].every(marker => labels.includes(marker.normalize("NFKC").trim()));
}
