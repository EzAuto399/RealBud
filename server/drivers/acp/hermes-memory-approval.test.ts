import { describe, expect, it } from 'vitest';
import { HERMES_MEMORY_APPROVAL, hermesMemoryPermission } from './hermes-memory-approval.ts';
import { evaluateRules } from '../../rules.ts';
import { approvalKey } from '../../auto-approve.ts';

const call = (description = 'Save to memory: add to memory', command = 'git is our preferred change tracker') => ({
  kind: 'execute', rawInput: { description, command }, title: `${description}: ${command}`,
});

describe('pinned native Hermes memory permission classification', () => {
  it.each(['add to memory', 'add to user profile'])('recognizes %s as complete literal memory content', operation => {
    const content = 'First line 私人\n<not-html>\nFinal line with spacing  ', description = `Save to memory: ${operation}`;
    expect(hermesMemoryPermission(call(description, content))).toEqual({ kind: 'memory', review: { description, content, complete: true } });
  });

  it.each(['replace in memory', 'replace in user profile', 'remove from memory', 'remove from user profile',
    'apply 2 op(s) to memory', 'apply 12 op(s) to user profile'])('holds %s because the callback cannot prove the complete existing entry or typed batch', operation => {
    expect(hermesMemoryPermission(call(`Save to memory: ${operation}`, 'short matching substring'))).toEqual({ kind: 'invalid-memory' });
  });

  it('cannot inherit a git shell grant from memory prose beginning with git', () => {
    const source = call(), rules = [{ id: 'fictional', key: 'shell:git', decision: 'allow' as const, label: 'Run git commands', createdAt: 1 }];
    expect(evaluateRules(rules, 'shell', source.rawInput.command)).toBe('allow'); // reproduced original collision
    expect(hermesMemoryPermission(source).kind).toBe('memory');
    expect(approvalKey(HERMES_MEMORY_APPROVAL, source.rawInput.command)).not.toBe('shell:git');
    expect(evaluateRules(rules, HERMES_MEMORY_APPROVAL, source.rawInput.command)).toBeNull();
  });

  it.each([
    { name: 'missing detail', change: (row: ReturnType<typeof call>) => ({ ...row, rawInput: { description: row.rawInput.description } }) },
    { name: 'non-string detail', change: (row: ReturnType<typeof call>) => ({ ...row, rawInput: { ...row.rawInput, command: ['git'] } }) },
    { name: 'mismatched title', change: (row: ReturnType<typeof call>) => ({ ...row, title: 'echo hi' }) },
    { name: 'wrong casing', change: () => call('save to memory: add to memory') },
    { name: 'unknown operation', change: () => call('Save to memory: write this file') },
    { name: 'conflicting action', change: (row: ReturnType<typeof call>) => ({ ...row, rawInput: { ...row.rawInput, name: 'terminal' } }) },
    { name: 'extra path', change: (row: ReturnType<typeof call>) => ({ ...row, rawInput: { ...row.rawInput, path: '/fictional' } }) },
    { name: 'wrong kind', change: (row: ReturnType<typeof call>) => ({ ...row, kind: 'edit' }) },
    { name: 'oversized detail', change: () => call(undefined, '漢'.repeat(22_000)) },
    { name: 'control characters', change: () => call(undefined, 'text\u0000hidden') },
    { name: 'credential-shaped content', change: () => call(undefined, 'api_key=fictional_rejected_credential') },
  ])('holds $name instead of falling back to shell', ({ change }) => {
    expect(hermesMemoryPermission(change(call()))).toEqual({ kind: 'invalid-memory' });
  });

  it('does not classify ordinary terminal content by words inside its command', () => {
    expect(hermesMemoryPermission({ kind: 'execute', rawInput: { command: 'echo "Save to memory: add to memory"', description: 'Run command' }, title: 'Run command' })).toEqual({ kind: 'other' });
  });

  it.each(['memory', ' MeMoRy ', HERMES_MEMORY_APPROVAL, ` ${HERMES_MEMORY_APPROVAL.toUpperCase()}:write `])('refuses masked reserved memory action %s', tool => {
    expect(hermesMemoryPermission({ kind: 'execute', rawInput: { name: 'terminal', tool, command: 'git is preferred' }, title: 'Run command' }))
      .toEqual({ kind: 'invalid-memory' });
  });
});
