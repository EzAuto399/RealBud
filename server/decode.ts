// Strict decoders. `"false"` is not a boolean. Missing IDs are not rows.
// A malformed batch is rejected as a whole — never coerced into action.

export function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw Object.assign(new Error(`${field} must be a non-empty string`), { status: 400, field });
  }
  return value.trim();
}

export function asFiniteInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isFinite(value)) {
    throw Object.assign(new Error(`${field} must be a finite integer`), { status: 400, field });
  }
  return value;
}

export function asFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw Object.assign(new Error(`${field} must be a finite number`), { status: 400, field });
  }
  return value;
}

export function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw Object.assign(new Error(`${field} must be a boolean`), { status: 400, field });
  }
  return value;
}

export function asNullableNumber(value: unknown, field: string): number | null {
  if (value == null) return null;
  return asFiniteNumber(value, field);
}

export function decodeFailed(error: unknown): error is Error & { status?: number } {
  return error instanceof Error;
}
