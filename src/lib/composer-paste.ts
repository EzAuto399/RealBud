// What a paste into the Ask composer becomes. Files on the clipboard
// (a screenshot, a copied image, files copied in Finder or Explorer) go
// through the same copy-to-this-desktop path as the Attach button; text
// keeps its existing behaviour (inline, or a chip when it is long).
//
// Rule: attach the clipboard files when there is at least one file AND the
// plain text is empty, a single URL, or only the copied files' own names.
// Browsers put the image URL beside a copied image, and file managers put the
// file name beside a copied file; neither is text the person meant to type.
// Any other text wins and the files are ignored, so pasting prose from a rich
// source never turns into a surprise attachment.

export type PasteDecision<T> = { kind: "files"; files: T[] } | { kind: "text" };

const URL_ONLY = /^(?:https?|file|data|blob):\S+$/i;

export function decidePaste<T extends { name: string }>(files: readonly T[], text: string): PasteDecision<T> {
  if (!files.length) return { kind: "text" };
  const trimmed = text.trim();
  if (!trimmed) return { kind: "files", files: [...files] };
  if (URL_ONLY.test(trimmed)) return { kind: "files", files: [...files] };
  const names = new Set(files.map((file) => file.name.trim()).filter(Boolean));
  const lines = trimmed.split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean);
  const baseName = (line: string) => line.split(/[/\\]/).pop() ?? line;
  if (names.size && lines.every((line) => names.has(line) || names.has(baseName(line)))) {
    return { kind: "files", files: [...files] };
  }
  return { kind: "text" };
}

const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** Chromium names every clipboard bitmap "image.png"; some sources give no name. */
const GENERIC_IMAGE_NAME = /^image\.(png|jpe?g|gif|webp)$/i;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** "Pasted image 2026-09-30 17.18" in the person's local time. */
export function pastedImageStem(now: Date): string {
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `Pasted image ${day} ${pad(now.getHours())}.${pad(now.getMinutes())}`;
}

/** Name a clipboard image that has no real file name. Real names are kept.
 * Several nameless images in one paste are numbered so each stays distinct. */
export function pastedFileNames(
  files: readonly { name: string; type: string }[],
  now: Date,
): string[] {
  const stem = pastedImageStem(now);
  const nameless = files.filter(isNamelessImage).length;
  let index = 0;
  return files.map((file) => {
    if (!isNamelessImage(file)) return file.name;
    index += 1;
    const type = file.type.toLowerCase();
    // An unsupported format keeps its own extension so the attach limits reject it honestly.
    const ext = IMAGE_EXT[type] ?? (type.split("/")[1]?.replace(/[^a-z0-9]/g, "") || "png");
    return nameless > 1 ? `${stem} (${index}).${ext}` : `${stem}.${ext}`;
  });
}

function isNamelessImage(file: { name: string; type: string }): boolean {
  if (!file.type.toLowerCase().startsWith("image/")) return false;
  const name = file.name.trim();
  return !name || GENERIC_IMAGE_NAME.test(name);
}

/** Clipboard files ready for the attach path, renamed where they had no name. */
export function namedPastedFiles(files: readonly File[], now: Date): File[] {
  const names = pastedFileNames(files, now);
  return files.map((file, i) =>
    names[i] === file.name ? file : new File([file], names[i], { type: file.type, lastModified: file.lastModified }),
  );
}
