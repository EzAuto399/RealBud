// Admission of EXISTING RealBud private objects on Windows. Mirrors the POSIX
// rule in private-json.ts (an owned folder whose only problem is being too open
// is tightened and admitted): an object whose only fault is that its DACL is
// still inherited, while every grant it inherits is already this account,
// SYSTEM or Administrators with no deny rule, is protected with the same
// descriptor RealBud gives a new object, re-verified and admitted. Older
// installations created the data folder that way. Every other refusal (an
// extra principal, a deny rule, a foreign owner, a reparse point, a helper that
// cannot run) is returned unchanged and nothing is modified: the script judges
// the inherited rules before it touches the descriptor (`repair` in
// windows-file-privacy.ts). Elsewhere these calls are the plain verification.
import { oplog } from './oplog.ts';
import { windowsFilePrivacyBatch, windowsFilePrivacyBatchSync, type WindowsFilePrivacyOperation } from './windows-file-privacy.ts';

/** Which operation of `count` was refused only for unprotected inheritance, or null. */
function inheritedOnly(error: unknown, count: number): number | null {
  const refusal = error as { name?: unknown; category?: unknown; operationIndex?: unknown } | null;
  if (refusal?.name !== 'WindowsFilePrivacyError' || refusal.category !== 'inheritance-not-protected') return null;
  // A one-operation batch carries no index by construction.
  if (count === 1) return 0;
  const index = refusal.operationIndex;
  return typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < count ? index : null;
}

/** One line per repaired object: the role and kind only, never a path. */
function repaired(role: string, kind: WindowsFilePrivacyOperation['kind']): void {
  oplog('storage', `${role} inherited its Windows permissions; RealBud limited it to this account.`,
    { repair: 'windows-acl:inheritance-not-protected', kind });
}

/**
 * The batch admission with the repair above. Each `verify` operation refused
 * only for unprotected inheritance is repaired on its own, then the rest of the
 * list continues in order; any other refusal throws as before. Returns the
 * indexes that were repaired (their ctime changed). `restrict` operations are
 * never repaired: they own a new object.
 */
export function admitPrivateObjectsSync(operations: WindowsFilePrivacyOperation[], role: string): number[] {
  const done: number[] = [];
  for (let start = 0; start < operations.length;) {
    const rest = operations.slice(start);
    try { windowsFilePrivacyBatchSync(rest); return done; }
    catch (error) {
      const at = inheritedOnly(error, rest.length);
      if (at === null || rest[at]!.action !== 'verify') throw error;
      windowsFilePrivacyBatchSync([{ ...rest[at]!, action: 'repair' }]);
      repaired(role, rest[at]!.kind);
      done.push(start + at);
      start += at + 1;
    }
  }
  return done;
}

/** The asynchronous form of `admitPrivateObjectsSync`. */
export async function admitPrivateObjects(operations: WindowsFilePrivacyOperation[], role: string): Promise<number[]> {
  const done: number[] = [];
  for (let start = 0; start < operations.length;) {
    const rest = operations.slice(start);
    try { await windowsFilePrivacyBatch(rest); return done; }
    catch (error) {
      const at = inheritedOnly(error, rest.length);
      if (at === null || rest[at]!.action !== 'verify') throw error;
      await windowsFilePrivacyBatch([{ ...rest[at]!, action: 'repair' }]);
      repaired(role, rest[at]!.kind);
      done.push(start + at);
      start += at + 1;
    }
  }
  return done;
}

/** One existing object; resolves true when it was repaired. */
export async function admitPrivateObject(path: string, kind: WindowsFilePrivacyOperation['kind'], role: string): Promise<boolean> {
  return (await admitPrivateObjects([{ path, kind, action: 'verify' }], role)).length > 0;
}
