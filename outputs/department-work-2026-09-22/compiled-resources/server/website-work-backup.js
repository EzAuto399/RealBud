import { executionDigest, executionStream } from "./execution-history.js";
import { REMOTE_EVIDENCE_KIND, validateRemoteEvidence } from "./website-remote-evidence.js";
import { REMOTE_TEMPLATE_KIND, validateRemoteTemplate } from "./website-remote-disclosure.js";
import { canonicalWebsiteCommand } from "../shared/website-commands.js";
import { WEBSITE_REMOTE_WORK_KIND, validateSavedWebsiteRemoteWork } from "./website-remote-work.js";
import { WEBSITE_REQUEST_KIND, validateSavedWebsiteRequest } from "./website-requests.js";
import { manualRecipeRequestKey } from "./manual-job-request.js";
const invalid = () => { throw Object.assign(new Error('Website request history does not match its workspace or execution receipts.'), { status: 400 }); };
export function validateWebsiteWorkGraph(reader, workspaceId) {
    for (const row of reader.iterate(REMOTE_EVIDENCE_KIND)) {
        if (validateRemoteEvidence(row.id, row.value).workspaceId !== workspaceId)
            return invalid();
    }
    for (const row of reader.iterate(REMOTE_TEMPLATE_KIND)) {
        if (validateRemoteTemplate(row.id, row.value).workspaceId !== workspaceId)
            return invalid();
    }
    for (const kind of [WEBSITE_REQUEST_KIND, WEBSITE_REMOTE_WORK_KIND])
        for (const row of reader.iterate(kind)) {
            const saved = kind === WEBSITE_REQUEST_KIND ? validateSavedWebsiteRequest(row.id, row.value) : validateSavedWebsiteRemoteWork(row.id, row.value);
            if (saved.version === 2 && saved.publication) {
                const review = saved.publication.review, envelope = saved.envelope;
                const templates = reader.iterate(REMOTE_TEMPLATE_KIND);
                let matchedTemplate = false;
                for (const template of templates) {
                    const evidence = validateRemoteTemplate(template.id, template.value);
                    if (evidence.workspaceId === workspaceId && evidence.digest === review.templateDigest && canonicalWebsiteCommand(evidence.template) === canonicalWebsiteCommand(review.template))
                        matchedTemplate = true;
                }
                if (!matchedTemplate)
                    return invalid();
                for (const member of review.audience) {
                    const record = reader.get(REMOTE_EVIDENCE_KIND, `remote-enrollment:${member.enrollmentId}`);
                    if (!record)
                        return invalid();
                    const evidence = validateRemoteEvidence(record.id, record.value), grant = evidence.approver;
                    if (!grant || grant.workspaceId !== workspaceId || grant.id !== member.enrollmentId || grant.generation !== member.generation ||
                        grant.parentGrantId !== envelope.grantId || grant.parentGeneration !== envelope.generation ||
                        grant.installationId !== envelope.installationId || grant.workerBinding !== envelope.workerBinding || grant.companyId !== envelope.companyId ||
                        canonicalWebsiteCommand(grant.person) !== canonicalWebsiteCommand(member.person) ||
                        !grant.scopes.some(scope => scope.descriptorId === review.descriptorId && scope.descriptorRevision === review.descriptorRevision && scope.disclosureDigest === review.templateDigest))
                        return invalid();
                }
            }
            if (saved.identity.workspaceId !== workspaceId)
                return invalid();
            if (!saved.run && !saved.intent)
                continue;
            const binding = saved.preview?.binding;
            if (!binding || typeof binding.recipeId !== 'string' || !Number.isSafeInteger(binding.recipeRevision))
                return invalid();
            const type = saved.envelope.descriptor.operation === 'morning-review' ? 'loop' : 'job';
            const stream = executionStream(type, type === 'job' ? 'job-runs.json' : 'loops.json');
            const key = type === 'loop' ? saved.envelope.id : manualRecipeRequestKey({ id: binding.recipeId, revision: Number(binding.recipeRevision) }, { requestId: saved.envelope.id, expectedRevision: binding.recipeRevision }, 'prepare');
            const request = reader.get('execution-request', `request:${stream}:${executionDigest(key)}`)?.value;
            // A claim/dispatch intent saved before enqueue is valid negative evidence.
            if (!request) {
                if (saved.run)
                    return invalid();
                continue;
            }
            const receipt = reader.get(`execution-${type}`, `${stream}:${executionDigest(request.runId)}`)?.value;
            if (!receipt || request.key !== key || request.binding !== receipt.binding || saved.run && saved.run.id !== request.runId)
                return invalid();
            if (type === 'job') {
                const run = receipt.run;
                if (run.jobId !== binding.recipeId || run.jobRevision !== binding.recipeRevision || run.mode !== 'prepare' || run.trigger !== 'manual' || run.idempotencyKey !== key)
                    return invalid();
            }
            else {
                const run = receipt.run, morning = binding.morning;
                if (run.loopId !== 'inbound-triage' || !run.manual || run.requestId !== key || run.loopRevision !== morning?.loopRevision)
                    return invalid();
            }
        }
}
