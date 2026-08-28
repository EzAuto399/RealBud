"use strict";

const RUN_ID = /^[a-zA-Z0-9-]{1,100}$/;

/** The renderer is untrusted at the desktop boundary. Accept only the opaque
 * identifier and the closed code-owned reason; every extra field is dropped. */
function parseRoutineReminder(input) {
  if (!input || typeof input !== "object") return null;
  const runId = typeof input.runId === "string" && RUN_ID.test(input.runId) ? input.runId : null;
  const kind = input.kind === "failed" || input.kind === "held" ? input.kind : null;
  return runId && kind ? { runId, kind } : null;
}

/** Shell-owned copy only. No model or renderer string can reach a lock screen. */
function routineNotificationCopy(kind) {
  return {
    title: kind === "failed" ? "A RealBud routine needs attention" : "RealBud left work on hold",
    body: "Open RealBud to review it. Nothing was sent.",
  };
}

module.exports = { parseRoutineReminder, routineNotificationCopy };
