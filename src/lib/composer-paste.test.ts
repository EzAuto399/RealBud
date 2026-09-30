import { describe, expect, it } from "vitest";
import { decidePaste, namedPastedFiles, pastedFileNames, pastedImageStem } from "./composer-paste";

const at = new Date(2026, 8, 30, 17, 18, 42);
const shot = { name: "image.png", type: "image/png" };

describe("decidePaste", () => {
  it("keeps plain text paste when the clipboard has no files", () => {
    expect(decidePaste([], "hello")).toEqual({ kind: "text" });
    expect(decidePaste([], "")).toEqual({ kind: "text" });
  });

  it("attaches a screenshot with no text", () => {
    expect(decidePaste([shot], "")).toEqual({ kind: "files", files: [shot] });
    expect(decidePaste([shot], "  \n")).toEqual({ kind: "files", files: [shot] });
  });

  it("attaches an image copied from a browser that also carries its URL", () => {
    expect(decidePaste([shot], "https://example.test/photo.png").kind).toBe("files");
    expect(decidePaste([shot], "data:image/png;base64,AAAA").kind).toBe("files");
  });

  it("attaches files copied in a file manager that also carries their names", () => {
    const a = { name: "lease.pdf", type: "application/pdf" };
    const b = { name: "photo.jpg", type: "image/jpeg" };
    expect(decidePaste([a], "lease.pdf").kind).toBe("files");
    expect(decidePaste([a, b], "lease.pdf\nphoto.jpg").kind).toBe("files");
    expect(decidePaste([a], "/Users/sample/Documents/lease.pdf").kind).toBe("files");
  });

  it("lets real text win over clipboard files", () => {
    expect(decidePaste([shot], "Please review the attached arrears notice")).toEqual({ kind: "text" });
    expect(decidePaste([shot], "see https://example.test/photo.png")).toEqual({ kind: "text" });
    expect(decidePaste([{ name: "lease.pdf", type: "application/pdf" }], "lease.pdf\nand more notes")).toEqual({ kind: "text" });
  });
});

describe("pasted image naming", () => {
  it("uses local date and time with a dot between hour and minute", () => {
    expect(pastedImageStem(at)).toBe("Pasted image 2026-09-30 17.18");
    expect(pastedImageStem(new Date(2026, 0, 5, 9, 7))).toBe("Pasted image 2026-01-05 09.07");
  });

  it("names a nameless clipboard image and keeps real file names", () => {
    expect(pastedFileNames([shot], at)).toEqual(["Pasted image 2026-09-30 17.18.png"]);
    expect(pastedFileNames([{ name: "", type: "image/jpeg" }], at)).toEqual(["Pasted image 2026-09-30 17.18.jpg"]);
    expect(pastedFileNames([{ name: "front door.png", type: "image/png" }], at)).toEqual(["front door.png"]);
    expect(pastedFileNames([{ name: "lease.pdf", type: "application/pdf" }], at)).toEqual(["lease.pdf"]);
  });

  it("numbers several nameless images in one paste", () => {
    expect(pastedFileNames([shot, { name: "image.png", type: "image/png" }], at)).toEqual([
      "Pasted image 2026-09-30 17.18 (1).png",
      "Pasted image 2026-09-30 17.18 (2).png",
    ]);
  });

  it("keeps an unsupported image format's extension so the attach limits reject it", () => {
    expect(pastedFileNames([{ name: "", type: "image/tiff" }], at)).toEqual(["Pasted image 2026-09-30 17.18.tiff"]);
  });

  it("renames File objects without changing their bytes or type", async () => {
    const original = new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" });
    const kept = new File(["x"], "notes.txt", { type: "text/plain" });
    const [renamed, same] = namedPastedFiles([original, kept], at);
    expect(renamed.name).toBe("Pasted image 2026-09-30 17.18.png");
    expect(renamed.type).toBe("image/png");
    expect(new Uint8Array(await renamed.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect(same).toBe(kept);
  });
});
