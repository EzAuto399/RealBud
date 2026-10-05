import { expect, it } from "vitest";

import { DiskFullError } from "./private-json.ts";
import { errorReply, OUT_OF_SPACE_MESSAGE } from "./http-error-reply.ts";

const path = "/synthetic/realbud/data/bots.json.1.tmp";
const raw = (code: string) => Object.assign(new Error(`${code}: failed, open '${path}'`), { code, syscall: "open", path });

it.each([raw("ENOSPC"), raw("EDQUOT"), new DiskFullError(raw("ENOSPC")), Object.assign(new Error("This Mac is out of space."), { status: 507, code: "storage-full" })])(
  "answers every full disk with one clear 507 and no path: %s", error => {
    const reply = errorReply(error);
    expect(reply.status).toBe(507);
    expect(reply.body.error).toBe(OUT_OF_SPACE_MESSAGE);
    expect(JSON.stringify(reply)).not.toContain("/synthetic");
  });

it("never sends the path from any other raw system error", () => {
  const reply = errorReply(raw("EACCES"));
  expect(reply).toMatchObject({ status: 500, body: { code: "storage_unavailable" } });
  expect(JSON.stringify(reply)).not.toContain("/synthetic");
});

it("keeps deliberate errors as they were", () => {
  expect(errorReply(Object.assign(new Error("no such bot"), { status: 404 }))).toEqual({ status: 404, body: { error: "no such bot" } });
  expect(errorReply(Object.assign(new Error("held"), { status: 503, code: "store_recovery_required" }))).toEqual({ status: 503, body: { error: "held", code: "store_recovery_required" } });
});
