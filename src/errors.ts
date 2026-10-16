export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export function demand(condition: unknown, status: number, message: string): asserts condition { if (!condition) throw new HttpError(status, message); }
export function text(value: unknown, name: string, max: number): string { demand(typeof value === "string" && value.trim().length > 0 && value.length <= max, 400, `${name} is required (maximum ${max} characters)`); return value.trim(); }
