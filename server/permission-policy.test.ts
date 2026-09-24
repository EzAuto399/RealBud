import { describe, expect, it } from 'vitest';
import { HERMES_MEMORY_APPROVAL, requiresOnceApproval, reservedApprovalKey, validMemoryApprovalReview } from '../shared/approval-policy.ts';
import { guardPermissionDecision, permissionCardFields, canUseReviewedPortalRules } from './permission-policy.ts';
import { autoDecision } from './auto-approve.ts';
import { addRule, evaluateRules, type BudRule } from './rules.ts';

const review = { description: 'Save to memory: add to memory', content: 'git is our preferred change tracker', complete: true as const };
const memory = { tool: HERMES_MEMORY_APPROVAL, summary: review.description, memoryReview: review };
const rules: BudRule[] = ['shell:git', HERMES_MEMORY_APPROVAL].map(key => ({ id: key, key, label: 'Fictional saved rule', decision: 'allow', createdAt: 1 }));

describe('host one-time memory approval policy', () => {
  it('preserves reviewed site rules only for typed named browser actions after the real fence admits them', () => {
    const decision = { kind: 'ask' as const, surface: 'portal-read' as const, origin: 'example.invalid' };
    const event = { tool: 'navigate', approvalPolicy: 'provider-once' as const, params: { url: 'https://example.invalid/property' } };
    expect(canUseReviewedPortalRules(event, decision)).toBe(true);
    expect(canUseReviewedPortalRules({ ...event, approvalPolicy: 'once' }, decision)).toBe(false);
    expect(canUseReviewedPortalRules({ ...event, approvalPolicy: undefined }, decision)).toBe(false);
    expect(canUseReviewedPortalRules({ ...event, tool: 'read' }, decision)).toBe(true);
    expect(canUseReviewedPortalRules({ ...event, tool: 'fill', params: { ...event.params, selector: '#reference', value: 'Fictional reference' } }, { ...decision, surface: 'portal-prefill' })).toBe(true);
    expect(canUseReviewedPortalRules(event, { ...decision, kind: 'deny' })).toBe(false);
    expect(canUseReviewedPortalRules(event, { ...decision, surface: 'portal-submit' })).toBe(false);
    expect(canUseReviewedPortalRules({ ...event, tool: HERMES_MEMORY_APPROVAL }, decision)).toBe(false);
    for (const tool of ['shell', 'execute_code', 'unknown', 'click_semantic']) expect(canUseReviewedPortalRules({ ...event, tool }, decision)).toBe(false);
    for (const params of [{ url: 'https://example.invalid', command: 'git status' }, { url: 'https://example.invalid', path: '/fictional/memory' }, { url: 'file:///fictional' }, { url: 'https://user:pass@example.invalid' }, { command: 'https://example.invalid' }]) expect(canUseReviewedPortalRules({ ...event, params }, decision)).toBe(false);
  });
  it('binds parsed website destinations to the actual fence origin even for noncanonical URLs', () => {
    const decision = { kind: 'ask' as const, surface: 'portal-read' as const, origin: 'example.invalid' };
    for (const url of ['https:/outside.invalid', 'https:\\outside.invalid', 'https://outside.invalid', 'https://example.invalid.outside.invalid']) {
      expect(canUseReviewedPortalRules({ tool: 'navigate', approvalPolicy: 'provider-once', params: { url } }, decision)).toBe(false);
    }
    expect(canUseReviewedPortalRules({ tool: 'navigate', approvalPolicy: 'provider-once', params: { url: 'https://www.example.invalid/' } }, decision)).toBe(true);
  });
  it('keeps provider-once browser requests manual until the host validates their job fence', () => {
    const event = { tool: 'navigate', summary: 'https://example.invalid/', approvalPolicy: 'provider-once' as const };
    expect(permissionCardFields(event)).toEqual({ approvalPolicy: 'provider-once' });
    expect(requiresOnceApproval(event)).toBe(true);
    expect(guardPermissionDecision(event, { behavior: 'allow', scope: 'session' })).toEqual({ behavior: 'allow', scope: 'once' });
    expect(() => guardPermissionDecision(event, { behavior: 'allow' }, { surface: 'portal-read', origin: 'example.invalid' })).toThrow(/saved rule/);
  });
  it('keeps complete prose intact without a shell grant or standing-rule key', () => {
    const card = permissionCardFields(memory);
    expect(card).toEqual({ approvalPolicy: 'once', memoryReview: review });
    expect(card.memoryReview).not.toBe(review);
    expect(evaluateRules(rules, memory.tool, review.content)).toBeNull();
    expect(autoDecision({ autoApprove: true, alwaysAllow: [HERMES_MEMORY_APPROVAL, 'shell:git'] }, memory.tool, review.content)).toBeNull();
  });
  it.each([HERMES_MEMORY_APPROVAL, `${HERMES_MEMORY_APPROVAL}:git`, ` ${HERMES_MEMORY_APPROVAL.toUpperCase()} `])('refuses a persisted rule for %s before writing any file', key => {
    expect(reservedApprovalKey(key)).toBe(true);
    expect(() => addRule(key, 'allow')).toThrow(/separate review/);
    expect(() => addRule(key, 'deny')).toThrow(/separate review/);
  });
  it('preserves normal terminal grants while generic one-time callbacks get no grant key', () => {
    expect(permissionCardFields({ tool: 'shell', summary: 'git status' })).toEqual({ allowKey: 'shell:git' });
    expect(evaluateRules(rules, 'shell', 'git status')).toBe('allow');
    expect(autoDecision({ autoApprove: true }, 'shell', 'git status')).toBeTruthy();
    expect(permissionCardFields({ tool: 'execute_code', summary: 'print(1)', approvalPolicy: 'once' })).toEqual({ approvalPolicy: 'once' });
    expect(requiresOnceApproval({ tool: 'unknown', approvalPolicy: 'once' })).toBe(true);
  });
  it('coerces a client session grant to one action and rejects rule expansion first', () => {
    expect(guardPermissionDecision(memory, { behavior: 'allow', scope: 'session' })).toEqual({ behavior: 'allow', scope: 'once' });
    expect(guardPermissionDecision({ tool: 'execute_code', approvalPolicy: 'once' }, { behavior: 'allow' })).toEqual({ behavior: 'allow', scope: 'once' });
    expect(() => guardPermissionDecision(memory, { behavior: 'allow' }, { surface: 'portal-read', origin: 'example.invalid' })).toThrow(/saved rule/);
    expect(() => guardPermissionDecision(memory, { behavior: 'answer', message: 'yes' })).toThrow(/Allow once or Deny/);
    expect(() => guardPermissionDecision(undefined, { behavior: 'allow' })).toThrow(/live approval record/);
  });
  it.each([undefined, { ...review, complete: false }, { ...review, description: 'Save to memory: replace in memory' }, { ...review, description: 'Save to memory: remove from user profile' }, { ...review, content: '' }, { ...review, content: '私'.repeat(22_000) }, { ...review, extra: 'forged' }])('holds incomplete or malformed review data while Deny remains usable', memoryReview => {
    expect(validMemoryApprovalReview(memoryReview)).toBe(false);
    expect(permissionCardFields({ ...memory, memoryReview })).toEqual({ approvalPolicy: 'once' });
    expect(() => guardPermissionDecision({ ...memory, memoryReview }, { behavior: 'allow' })).toThrow(/complete memory change/);
    expect(guardPermissionDecision({ ...memory, memoryReview }, { behavior: 'deny' })).toEqual({ behavior: 'deny' });
  });
  it('never stores a secret-bearing preview or approves an unseen redacted change', () => {
    const memoryReview = { ...review, content: `Fictional API_KEY=sk-test-${'x'.repeat(24)}` };
    expect(permissionCardFields({ ...memory, memoryReview })).toEqual({ approvalPolicy: 'once' });
    expect(() => guardPermissionDecision({ ...memory, memoryReview }, { behavior: 'allow' })).toThrow(/complete memory change/);
  });
  it('supports complete long non-ASCII memory without summary truncation', () => {
    const memoryReview = { ...review, content: 'Reviewable business preference 保留\n'.repeat(200) };
    expect(validMemoryApprovalReview(memoryReview)).toBe(true);
    expect(permissionCardFields({ ...memory, memoryReview }).memoryReview?.content).toBe(memoryReview.content);
  });
});
