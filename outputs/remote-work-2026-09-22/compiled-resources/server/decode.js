// Strict decoders. `"false"` is not a boolean. Missing IDs are not rows.
// A malformed batch is rejected as a whole — never coerced into action.
export function asNonEmptyString(value, field) {
    if (typeof value !== "string" || !value.trim()) {
        throw Object.assign(new Error(`${field} must be a non-empty string`), { status: 400, field });
    }
    return value.trim();
}
export function asFiniteInteger(value, field) {
    if (typeof value !== "number" || !Number.isInteger(value) || !Number.isFinite(value)) {
        throw Object.assign(new Error(`${field} must be a finite integer`), { status: 400, field });
    }
    return value;
}
export function asFiniteNumber(value, field) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw Object.assign(new Error(`${field} must be a finite number`), { status: 400, field });
    }
    return value;
}
export function asBoolean(value, field) {
    if (typeof value !== "boolean") {
        throw Object.assign(new Error(`${field} must be a boolean`), { status: 400, field });
    }
    return value;
}
export function asNullableNumber(value, field) {
    if (value == null)
        return null;
    return asFiniteNumber(value, field);
}
export function decodeFailed(error) {
    return error instanceof Error;
}
