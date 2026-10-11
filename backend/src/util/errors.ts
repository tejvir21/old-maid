import type { ApiError, ErrorCode } from "@old-maid/shared";

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
  toApi(): ApiError {
    return { code: this.code, message: this.message };
  }
}

export const err = (code: ErrorCode, message: string): { ok: false; error: ApiError } => ({
  ok: false,
  error: { code, message },
});

const STATUS: Partial<Record<ErrorCode, number>> = {
  UNAUTHORIZED: 401, FORBIDDEN: 403, BANNED: 403, NOT_FOUND: 404, ROOM_NOT_FOUND: 404,
  RATE_LIMITED: 429, MAINTENANCE: 503, FEATURE_DISABLED: 403, INTERNAL: 500, CONFLICT: 409,
};
export const statusFor = (code: ErrorCode): number => STATUS[code] ?? 400;
