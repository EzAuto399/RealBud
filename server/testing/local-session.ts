// Fixture owners read the per-boot session token from their own private data
// directory, exactly like Electron main. /api/session never serves it.
import { readLocalSession } from '../../shared/local-session.mjs';
import { windowsFilePrivacy } from '../windows-file-privacy.ts';

export async function readSessionToken(dataDirectory: string): Promise<string> {
  const record = await readLocalSession(dataDirectory, { verifyWindowsPrivacy: windowsFilePrivacy });
  if (!record) throw new Error('The fixture service has not published its local session yet.');
  return record.token;
}
