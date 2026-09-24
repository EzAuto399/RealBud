import { describe, expect, it } from 'vitest';
import { ADD_USERS_READ, parseProfileAclWitness, WITNESS } from './private-profile-fixture.ts';

describe('Windows fixture witness', () => {
  // A cmdlet auto-loads its PowerShell module: ~23 s per launch, or a
  // CouldNotAutoloadMatchingModule failure under the Windows test runner.
  it.each([['witness', WITNESS], ['users-read', ADD_USERS_READ]])('%s script uses no cmdlet and reads each path by indexed name', (_name, script) => {
    const code = script.split('\n').filter(line => !line.trim().startsWith('#')).join('\n');
    expect(code).toContain('GetAccessControl');
    expect(code).toContain('REALBUD_TEST_PROFILE_PATH_');
    expect(code.match(/\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/g)).toBeNull();
  });

  it('parses one plain line per path and refuses anything else', () => {
    const digest = 'a'.repeat(64);
    expect(parseProfileAclWitness(`witness 1 1 1 1 1 0 ${digest}\r\nwitness 0 0 1 0 1 1 ${'b'.repeat(64)}\r\n`, 2)).toEqual([
      { protected: true, currentOwner: true, ownerAllowed: true, onlyPrivateGrants: true, currentFullControl: true, hasDeny: false, sddlSha256: digest },
      { protected: false, currentOwner: false, ownerAllowed: true, onlyPrivateGrants: false, currentFullControl: true, hasDeny: true, sddlSha256: 'b'.repeat(64) },
    ]);
    for (const [stdout, count] of [[`witness 1 1 1 1 1 0 ${digest}\n`, 2], [`witness 1 1 1 1 1 0 ${digest}\nS-1-5-21-1\n`, 1], [`witness 2 1 1 1 1 0 ${digest}\n`, 1], [`witness 1 1 1 1 0 ${digest}\n`, 1], ['', 1]] as const) {
      expect(() => parseProfileAclWitness(stdout, count)).toThrow('Windows fixture witness returned invalid evidence.');
    }
  });
});
