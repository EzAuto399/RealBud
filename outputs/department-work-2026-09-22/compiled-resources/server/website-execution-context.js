/** Preserve website provenance through queued callbacks and awaited source checks. */
import { AsyncLocalStorage } from 'node:async_hooks';
export function createWebsiteExecutionContext(options) {
    const context = new AsyncLocalStorage();
    const missing = () => { throw Object.assign(new Error('Website execution permission changed. Review the request again.'), { status: 409 }); };
    function run(requestId, work) {
        return context.run({ requestId, required: true }, work);
    }
    function runLoop(requestId, work) {
        const inherited = context.getStore();
        return context.run({ requestId: requestId ?? '', required: inherited?.requestId === requestId && inherited?.required === true }, work);
    }
    async function check() {
        const current = context.getStore();
        if (!current?.requestId)
            return;
        const execution = options.binding(current.requestId);
        if (!execution) {
            if (current.required)
                missing();
            return;
        }
        await options.check(execution);
        // A disable/revoke during an awaited adapter probe must stop provider entry.
        if (!options.binding(current.requestId))
            missing();
    }
    return { run, runLoop, check };
}
