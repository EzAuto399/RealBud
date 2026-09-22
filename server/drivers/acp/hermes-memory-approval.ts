import { HERMES_MEMORY_APPROVAL, reservedApprovalKey, validMemoryApprovalReview, type MemoryApprovalReview } from '../../../shared/approval-policy.ts';
import { containsCredential } from '../../redact.ts';

export { HERMES_MEMORY_APPROVAL };
type MemoryPermission = { kind: 'other' } | { kind: 'invalid-memory' } | { kind: 'memory'; review: MemoryApprovalReview };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const marker = (value: unknown) => typeof value === 'string' && /^\s*Save\s+to\s+memory\b/i.test(value);
const memoryName = (value: unknown) => typeof value === 'string' &&
  (value.trim().toLowerCase() === 'memory' || reservedApprovalKey(value));
// Native replace/remove describe only an old_text substring, although they
// alter its entire matching entry. Batch callbacks are flattened prose without
// a typed before-state. Only a single add exposes the complete proposed change.
const descriptionPattern = /^Save to memory: add to (?:memory|user profile)$/;

/** Exact callback envelope from the admitted Hermes write_approval and ACP
 * permission bridge. The command field is memory text, never a shell command.
 * A changed or incomplete memory envelope must not fall through to shell rules.
 * A terminal command merely mentioning memory does not identify this callback. */
export function hermesMemoryPermission(toolCall: unknown): MemoryPermission {
  if (!object(toolCall)) return { kind: 'other' };
  const raw = object(toolCall.rawInput) ? toolCall.rawInput : null;
  const resemblesMemory = marker(raw?.description) || marker(toolCall.title) ||
    [raw?.name, raw?.tool, toolCall.kind].some(memoryName);
  if (!resemblesMemory) return { kind: 'other' };
  if (toolCall.kind !== 'execute' || !raw || Object.keys(raw).length !== 2 ||
      typeof raw.description !== 'string' || !descriptionPattern.test(raw.description) ||
      typeof raw.command !== 'string' || !raw.command.trim() ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(raw.command) ||
      containsCredential(raw.command) ||
      toolCall.title !== `${raw.description}: ${raw.command}`) return { kind: 'invalid-memory' };
  const review = { description: raw.description, content: raw.command, complete: true as const };
  return validMemoryApprovalReview(review) ? { kind: 'memory', review } : { kind: 'invalid-memory' };
}
