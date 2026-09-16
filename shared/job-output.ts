/** Complete PM drafts are larger than diagnostic notes. Keep both a per-item
 * and per-run bound so durable receipts remain practical to load and store. */
export const JOB_OUTPUT_MAX_CHARS = 12_000;
export const JOB_OUTPUT_TOTAL_CHARS = 32_000;
export const JOB_OUTPUT_TOO_LARGE =
  "Bud's prepared result is too large to keep completely. Split the job into smaller results and run it again.";
