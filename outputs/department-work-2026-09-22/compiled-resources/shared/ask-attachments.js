/** Selected documents are copied locally, never executed as attachments. */
export const ASK_ATTACH_MAX_BYTES = 8 * 1024 * 1024;
export const ASK_ATTACH_ACCEPT = ".pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.csv,.json,.md,.docx,.xlsx,.rtf,.log";
const ALLOWED_EXT = /\.(pdf|png|jpe?g|gif|webp|txt|csv|json|md|docx|xlsx|rtf|log)$/i;
export function isAskAttachName(name) {
    return ALLOWED_EXT.test(name.trim());
}
/** Keep the real extension when shortening names; valid on both desktop OSes. */
export function safeAskAttachName(name) {
    const base = (name.split(/[/\\]/).pop()?.trim() || "file.txt").normalize("NFC");
    const extension = base.match(ALLOWED_EXT)?.[0].toLowerCase() ?? ".txt";
    const stem = base.slice(0, base.length - (base.match(ALLOWED_EXT)?.[0].length ?? 0));
    let clean = Array.from(stem.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_")).slice(0, 60).join("").replace(/[. ]+$/g, "");
    while (new TextEncoder().encode(clean).byteLength > 160)
        clean = Array.from(clean).slice(0, -1).join("");
    if (!clean || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(clean))
        clean = `_${clean || "file"}`;
    return clean + extension;
}
