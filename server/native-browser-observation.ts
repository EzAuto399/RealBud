/** Translate the native engine's full accessibility snapshot into our own
 * explicitly named format. It is not BrowserSkill VOM. Only parsed nodes and
 * observed attributes enter the tree; malformed/partial shapes are refused. */
export function nativeBrowserObservation(snapshot: unknown): string {
  if (typeof snapshot !== "string" || !snapshot.trim() || snapshot.length > 400_000 || /[\x00\r\t]/.test(snapshot)) throw new Error("The work browser returned an unsupported accessibility observation.");
  const out = ["@native-ax 1", "rootwebarea"];
  const refs = new Set<string>();
  // The output line of the latest node at each depth, so a link's destination finds its link.
  const at: { line: number; role: string; url: boolean }[] = [];
  let nodes = 0;
  for (const line of snapshot.split("\n")) {
    if (!line.trim()) continue;
    const match = line.match(/^( *)- ([a-zA-Z][\w-]*)(?: "((?:[^"\\]|\\.)*)")?(.*)$/);
    // A link's destination is metadata, never a node or an action: it stays on its own link as
    // url="…", last on the line, so the authority can check where a click goes (browser-authority.ts plainLink).
    const destination = line.match(/^( +)- \/url: (.*)$/);
    if (destination) {
      // Its owner is the latest node one level up, still open (a later shallower node closes it).
      const depth = destination[1].length / 2;
      const owner = Number.isInteger(depth) && at.length >= depth ? at[depth - 1] : undefined;
      let url = destination[2].trim();
      // A quoted address is the engine's escaped form; one JSON cannot read (a \x0b the browser strips) is left out, never kept raw.
      if (url.startsWith('"')) { try { const decoded: unknown = JSON.parse(url); url = typeof decoded === "string" ? decoded : ""; } catch { url = ""; } }
      // Anything else (not under a link, a second destination, an odd or overlong address) is left out, as before: no url, no shortcut.
      if (owner?.role === "link" && !owner.url && url && url.length <= 2048 && !/[\x00-\x1f\x7f]/.test(url)) { out[owner.line] += ` url=${JSON.stringify(url)}`; owner.url = true; }
      continue;
    }
    if (!match || match[1].length > 120 || match[1].length % 2) throw new Error("The work browser returned an unsupported accessibility observation.");
    const [, space, rawRole, quoted, tail] = match;
    const role = rawRole.toLowerCase() === "text" ? "statictext" : rawRole.toLowerCase();
    let name: string | undefined;
    try { if (quoted !== undefined) name = JSON.parse(`"${quoted}"`) as string; } catch { throw new Error("The work browser returned an unsupported accessibility name."); }
    let rest = tail; let ref = ""; const flags: string[] = [];
    while (rest.startsWith(" [")) {
      const flag = rest.match(/^ \[([^\]\n]+)\]/);
      if (!flag) throw new Error("The work browser returned an unsupported accessibility state.");
      for (const value of flag[1].split(/, */)) {
        if (/^ref=e[1-9]\d*$/.test(value)) {
          if (ref || refs.has(value)) throw new Error("The work browser returned repeated control references.");
          refs.add(value); ref = `@${value.slice(4)} `;
        } else if (/^(?:disabled|checked|selected|expanded|collapsed|pressed|readonly|required|hidden|invisible|aria-hidden|focused|mixed|active|multiselectable|editable|modal|level=\d+|checked=(?:true|false|mixed)|selected=(?:true|false)|expanded=(?:true|false))$/.test(value)) flags.push(`[${value}]`);
        else throw new Error("The work browser returned an unsupported accessibility state.");
      }
      rest = rest.slice(flag[0].length);
    }
    if (rest && !rest.startsWith(":")) throw new Error("The work browser returned an unsupported accessibility value.");
    const rawValue = rest.startsWith(":") ? rest.slice(1).trimStart() : "";
    let value = rawValue;
    if (rawValue.startsWith('"')) { try { const decoded: unknown = JSON.parse(rawValue); if (typeof decoded === "string") value = decoded; } catch { /* Native plain text may begin with a quote. */ } }
    if (/[\x00-\x1f]/.test(name ?? "") || /[\x00-\x1f]/.test(value)) throw new Error("The work browser returned an unsupported multiline accessibility value.");
    const field = /^(?:textbox|searchbox|textarea|editable|textfield|combobox|spinbutton|slider)$/.test(role);
    if (role === "statictext" && name === undefined) name = value;
    at.length = space.length / 2; at.push({ line: out.length, role, url: false });
    out.push(`${space}  ${ref}${role}${name !== undefined ? ` ${JSON.stringify(name)}` : ""}${flags.length ? ` ${flags.join(" ")}` : ""}${field && rest.startsWith(":") ? ` value=${JSON.stringify(value)}` : ""}`);
    if (value && !field && role !== "statictext") out.push(`${space}    statictext ${JSON.stringify(value)}`);
    nodes++;
  }
  if (!nodes) throw new Error("The work browser returned no supported accessibility nodes.");
  return out.join("\n");
}

export const isNativeBrowserObservation = (text: string): boolean => text.startsWith("@native-ax 1\n");
