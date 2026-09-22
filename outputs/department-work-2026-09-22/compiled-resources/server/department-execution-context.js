/** Carry department authority to provider and source entry without replacing provenance. */
import { AsyncLocalStorage } from 'node:async_hooks';
export class DepartmentExecutionContextError extends Error {
    code = 'department_execution_stale';
    status = 409;
    constructor() {
        super('Department execution permission changed. Check the case before continuing.');
        this.name = 'DepartmentExecutionContextError';
    }
}
export function createDepartmentExecutionContext(options) {
    const context = new AsyncLocalStorage();
    const deny = () => { throw new DepartmentExecutionContextError(); };
    const operationId = (value) => typeof value === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
    function snapshot(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value) ||
            Object.keys(value).sort().join(',') !== 'executionId,grantId')
            return deny();
        const { grantId, executionId } = value;
        if (!operationId(grantId) || !operationId(executionId))
            return deny();
        return Object.freeze({ grantId, executionId });
    }
    function requireCurrent(binding) {
        if (options.current(binding) !== true)
            deny();
    }
    function run(binding, work) {
        const next = snapshot(binding), inherited = context.getStore();
        if (inherited && (inherited.grantId !== next.grantId || inherited.executionId !== next.executionId))
            return deny();
        // Identical nesting inherits the existing object; it cannot clear a required context.
        const current = inherited ?? next;
        requireCurrent(current);
        return inherited ? work() : context.run(current, work);
    }
    async function check() {
        const binding = context.getStore();
        if (!binding)
            return; // Ordinary private work has its own independent admission.
        requireCurrent(binding);
        await options.check(binding);
        requireCurrent(binding);
    }
    // A revoked execution keeps its provenance so callers cannot mistake it for private work.
    function active() { return context.getStore() ?? null; }
    return { run, check, active };
}
