// Native (un-normalized) protocol tee — the debugging trick from upstream's
// EventNdjsonLogger and agentcal's onRaw: every provider-native message is
// written verbatim next to the canonical stream, so protocol drift can be
// diagnosed by diffing the two. It is a private debugging log only (nothing
// recovers or replays from it), so the ACP core keeps a work-browser or
// sign-in call's page addresses there as their origin (withPageToolOrigins).
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { NATIVE_DIR } from "../config.ts";
import { redactSecrets } from "../redact.ts";

export function appendNative(threadId: string, entry: { dir: "in" | "out"; source: string; msg: unknown }) {
  try {
    appendFileSync(
      join(NATIVE_DIR, `${threadId}.ndjson`),
      JSON.stringify(redactSecrets({ at: new Date().toISOString(), ...entry })) + "\n",
    );
  } catch {
    /* never let logging break a run */
  }
}
