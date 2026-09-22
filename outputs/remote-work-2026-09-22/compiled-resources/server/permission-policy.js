import { HERMES_MEMORY_APPROVAL, requiresOnceApproval, validMemoryApprovalReview } from "../shared/approval-policy.js";
import { approvalKey } from "./auto-approve.js";
import { containsCredential } from "./redact.js";
import { normalizeToolName, originMatches } from "./portal-fence.js";
/** A verified job fence is already a separate authority boundary. Preserve its
 * explicit site read/prefill rules only for a named, typed browser action.
 * Generic prose, filesystem reads and script payloads cannot inherit it. */
export function canUseReviewedPortalRules(event, decision) {
    if (event.approvalPolicy !== 'provider-once' || event.tool === HERMES_MEMORY_APPROVAL || decision.kind === 'deny' || !decision.origin ||
        !['portal-read', 'portal-prefill'].includes(decision.surface ?? ''))
        return false;
    const tool = normalizeToolName(event.tool ?? ''), params = event.params;
    if (!['navigate', 'read', 'fill'].includes(tool) || !params || typeof params !== 'object' || Array.isArray(params))
        return false;
    const fields = params;
    const allowed = tool === 'fill' ? ['url', 'selector', 'value'] : ['url'];
    if (Object.keys(fields).some(key => !allowed.includes(key)) || typeof fields.url !== 'string')
        return false;
    if (tool === 'fill' && (typeof fields.selector !== 'string' || !fields.selector.trim() || typeof fields.value !== 'string' || decision.surface !== 'portal-prefill'))
        return false;
    if (tool !== 'fill' && decision.surface !== 'portal-read')
        return false;
    try {
        const url = new URL(fields.url);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
            originMatches(url.hostname.toLowerCase().replace(/^www\./, ''), [decision.origin]);
    }
    catch {
        return false;
    }
}
/** Only complete, non-secret native review data may enter an approval card.
 * A redacted preview must never authorize the original unseen change. */
export function permissionCardFields(event) {
    if (!requiresOnceApproval(event))
        return { allowKey: approvalKey(event.tool, event.summary) };
    const review = event.memoryReview;
    return { approvalPolicy: event.tool === HERMES_MEMORY_APPROVAL ? 'once' : event.approvalPolicy, ...(event.tool === HERMES_MEMORY_APPROVAL && validMemoryApprovalReview(review) &&
            !containsCredential(review.description) && !containsCredential(review.content)
            ? { memoryReview: { ...review } } : {}) };
}
/** Both respond endpoints must resolve the exact live map->card before this
 * gate. Client scope/rules never broaden a one-time native request. */
export function guardPermissionDecision(card, decision, rule) {
    if (!card)
        throw Object.assign(new Error('This live approval record is unavailable. Refresh the conversation.'), { status: 409 });
    if (!requiresOnceApproval(card))
        return decision;
    if (rule)
        throw Object.assign(new Error('This request needs a separate review each time. A saved rule cannot approve it.'), { status: 400 });
    if (decision.behavior !== 'allow' && decision.behavior !== 'deny')
        throw Object.assign(new Error('Choose Allow once or Deny for this request.'), { status: 400 });
    if (decision.behavior === 'allow') {
        const review = card.memoryReview;
        if (card.tool === HERMES_MEMORY_APPROVAL && (!validMemoryApprovalReview(review) || containsCredential(review.description) || containsCredential(review.content))) {
            throw Object.assign(new Error('The complete memory change is unavailable for review. Deny it and ask Bud to prepare it again.'), { status: 409 });
        }
        return { ...decision, scope: 'once' };
    }
    return decision;
}
