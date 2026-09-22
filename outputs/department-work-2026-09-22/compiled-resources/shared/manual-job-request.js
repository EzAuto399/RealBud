export const MANUAL_JOB_REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** A request belongs to one saved plan and one kind of work. */
export function manualJobRequestKey(jobId, revision, mode, requestId) {
    return `${jobId}:${revision}:${mode}:manual:${requestId.toLowerCase()}`;
}
