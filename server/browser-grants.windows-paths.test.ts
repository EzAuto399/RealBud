// Windows: fs.promises.realpath is the native call, which expands 8.3 short
// names (C:\Users\RUNNER~1 -> C:\Users\runneradmin) and returns on-disk case,
// while realpathSync, which names the ask-uploads copy, keeps the spelling it
// was given. The mock below gives the native call that behaviour on any host.
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const realpath = async (path: string) => (await actual.realpath(path)).replace("rb-short-", "rb-LONGNAME-");
  return { ...actual, realpath, default: { ...actual, realpath } };
});

const { saveAskAttachment } = await import("./ask-attach.ts");
const { threadAttachedFiles } = await import("./browser-grants.ts");
const { privateTempRoot, removeFixture } = await import("./testing/private-fixture.ts");

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await removeFixture(root); });

it("finds the person's attachment when the native realpath spells the data folder differently", async () => {
  const root = privateTempRoot(join(tmpdir(), "rb-short-")); roots.push(root);
  const { path } = saveAskAttachment(root, { name: "fictional-lease.pdf", contentBase64: Buffer.from("%PDF-1.7 fictional").toString("base64") });
  const text = `<attached-file path="${path}" />`;
  expect(await threadAttachedFiles(root, [{ role: "user", text }])).toEqual([{ name: "fictional-lease.pdf", path }]);
});
