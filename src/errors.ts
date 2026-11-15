/** Error codes defined by docs/contract.md section 1. */
export const ERROR_CODES = [
  "invalid_argument",
  "not_found",
  "platform_unavailable",
  "blocked",
  "lobby_timeout",
  "not_live",
  "rate_limited",
  "upstream_error",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** A failure that maps one to one onto a contract error result. */
export class QuorumError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "QuorumError";
    this.code = code;
  }
}

export type ToolSuccess<T extends object> = { ok: true } & T;
export interface ToolFailure {
  ok: false;
  error: { code: ErrorCode; message: string };
}
export type ToolResult<T extends object = object> = ToolSuccess<T> | ToolFailure;

export function success<T extends object>(value: T): ToolSuccess<T> {
  return { ok: true, ...value };
}

export function failure(code: ErrorCode, message: string): ToolFailure {
  return { ok: false, error: { code, message } };
}

/** Converts anything thrown into a contract error result; unknown errors become upstream_error. */
export function toFailure(err: unknown): ToolFailure {
  if (err instanceof QuorumError) {
    return failure(err.code, err.message);
  }
  const message = err instanceof Error ? err.message : String(err);
  return failure("upstream_error", message);
}
