// Fast, explicit connected-app requests. These are handled by RealBud's
// connection broker before a model turn starts, so "connect Notion" cannot
// turn into a shell command plus a second, redundant permission prompt.
const ALIASES = {
    "x": { slug: "x", label: "X" },
    "google calendar": { slug: "googlecalendar", label: "Google Calendar" },
    "google calendars": { slug: "googlecalendar", label: "Google Calendar" },
    "google sheets": { slug: "googlesheets", label: "Google Sheets" },
    "google docs": { slug: "googledocs", label: "Google Docs" },
    "google drive": { slug: "googledrive", label: "Google Drive" },
    "gmail": { slug: "gmail", label: "Gmail" },
    "github": { slug: "github", label: "GitHub" },
    "notion": { slug: "notion", label: "Notion" },
    "microsoft outlook": { slug: "outlook", label: "Microsoft Outlook" },
    "outlook": { slug: "outlook", label: "Microsoft Outlook" },
    "microsoft 365": { slug: "microsoft365", label: "Microsoft 365" },
};
function titleCase(value) {
    return value
        .split(/[\s_-]+/)
        .filter(Boolean)
        .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1).toLowerCase())
        .join(" ");
}
/**
 * Match only a direct instruction whose whole job is connecting one app.
 * Questions such as "how do I connect Notion?" and compound work such as
 * "connect Notion and delete a page" deliberately stay ordinary turns.
 */
export function parseConnectionIntent(text) {
    const match = /^\s*(?:please\s+)?(?:connect|link|authori[sz]e|set\s*up)\s+(?:(?:me|us)\s+to\s+|my\s+|our\s+)?(?:the\s+)?([a-z0-9][a-z0-9 ._-]{0,48}?)(?:\s+(?:account|workspace|app|integration))?[.!]?\s*$/i.exec(text);
    if (!match)
        return null;
    const name = match[1].trim().replace(/[._-]+/g, " ").replace(/\s+/g, " ").toLowerCase();
    if (!name || /\b(and|then|after|before|delete|send|pay|publish|submit)\b/i.test(name))
        return null;
    const known = ALIASES[name];
    if (known)
        return known;
    const slug = name.replace(/[^a-z0-9]+/g, "");
    if (slug.length < 2 || slug.length > 40)
        return null;
    return { slug, label: titleCase(name) };
}
/** Whole-request matches only: work and pasted evidence must keep their meaning. */
export function parseConnectedStatusIntent(text) {
    const value = text.trim().replace(/[?!.]+$/, "");
    if (!value || value.length > 180 || /[\r\n]/.test(value))
        return false;
    return /^(?:please )?(?:(?:what|which) (?:services|apps|accounts|integrations|sources)(?: (?:are (?:we |they )?|am i ))?(?:connected|linked)(?: to)?|what(?:'s| is| are)(?: (?:we|i))? (?:connected|linked)(?: to)?|what are (?:we|you) connected to|(?:show|list)(?: me)?(?: my| our| the)? (?:connected (?:apps|services|accounts|sources)|connections|office sources)|(?:are we|am i) connected(?: to (?:gmail|outlook))?|is (?:gmail|outlook) connected|(?:what|which) (?:apps|sources|tools) can (?:you|bud) use)$/i.test(value);
}
/** Product controls are whole requests. Never interpret source text as a control. */
export function parseAskControlIntent(text) {
    const value = text.trim().replace(/[?!.]+$/, "");
    if (!value || value.length > 400 || /[\r\n]/.test(value))
        return null;
    if (/^(?:what(?:'s| is| have (?:we|i))|show(?: me)?|list)(?: (?:my|our|the))? (?:scheduled(?: jobs| work)?|schedule|routines|recurring jobs)(?: (?:for today|today|this week))?$/i.test(value))
        return "schedule-status";
    if (/^(?:please )?(?:schedule|remind me|set up (?:a |an )?(?:schedule|reminder|recurring)|(?:can you |help me )?(?:add|create|make|change|pause|stop|reschedule) (?:a |an |my |our |the |this )?(?:schedule|reminder|recurring job))\b/i.test(value))
        return "schedule-edit";
    if (/^(?:(?:how|where) (?:do|can) i (?:connect|link|set up) (?:my |our )?(?:gmail|outlook|office apps|connected apps)|(?:help me )?(?:connect (?:an? )?(?:app|office app)|set up (?:office apps|connected apps)))$/i.test(value))
        return "connections";
    if (/^(?:(?:how|where) (?:do|can) i (?:set up|fix|connect) bud|(?:help me )?(?:set up|fix|connect) bud|why (?:isn't|is not) bud (?:ready|working))$/i.test(value))
        return "setup";
    return null;
}
export function isAskProductControl(text) {
    return Boolean(parseConnectedStatusIntent(text) || parseAskControlIntent(text) || parseConnectionIntent(text) || /^check (?:gmail|outlook) connection[.!?]?$/i.test(text.trim()));
}
