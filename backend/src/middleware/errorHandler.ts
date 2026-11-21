import { ErrorRequestHandler } from "express";

export interface ErrorDetail {
  field: string;
  issue: string;
}

export interface StandardErrorPayload {
  code: string;
  message: string;
  details?: ErrorDetail[];
}

export interface StandardErrorResponse {
  error: StandardErrorPayload;
}

export function defaultCodeForStatus(status: number): string {
  switch (status) {
    case 400:
      return "BAD_REQUEST";
    case 401:
      return "UNAUTHORIZED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 422:
      return "UNPROCESSABLE_ENTITY";
    case 429:
      return "RATE_LIMIT_EXCEEDED";
    case 504:
      return "GATEWAY_TIMEOUT";
    default:
      return status >= 500 ? "INTERNAL_SERVER_ERROR" : "ERROR";
  }
}

export class AppError extends Error {
  public code: string;
  public details?: ErrorDetail[];

  constructor(
    public statusCode: number,
    message: string,
    code?: string,
    details?: ErrorDetail[],
  ) {
    super(message);
    this.name = "AppError";
    this.code = code || defaultCodeForStatus(statusCode);
    this.details = details;
  }
}

export class DatabaseTimeoutError extends AppError {
  constructor(message = "Gateway Timeout") {
    super(504, message, "GATEWAY_TIMEOUT");
    this.name = "DatabaseTimeoutError";
  }
}

/**
 * Detect database query execution timeouts and connection pool exhaustion errors.
 * Matches:
 * - Prisma P2024: Timed out fetching a new connection from the connection pool
 * - Postgres 57014: query_canceled due to statement_timeout
 * - DatabaseTimeoutError / TimeoutError instances
 */
export function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (err instanceof DatabaseTimeoutError) return true;
  if (err instanceof AppError && err.statusCode === 504) return true;

  const error = err as { code?: string; message?: string; name?: string };
  const message = (error.message || "").toLowerCase();
  const code = error.code || "";
  const name = error.name || "";

  return (
    code === "P2024" ||
    code === "57014" ||
    name === "DatabaseTimeoutError" ||
    name === "TimeoutError" ||
    message.includes("statement timeout") ||
    message.includes("canceling statement due to statement timeout") ||
    message.includes("query execution timed out") ||
    message.includes("timed out fetching a new connection from the connection pool") ||
    message.includes("connection pool timeout")
  );
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const isTimeout = isTimeoutError(err);
  const status = isTimeout ? 504 : err instanceof AppError ? err.statusCode : 500;

  const message =
    status === 504
      ? "Gateway Timeout"
      : status < 500
        ? (err as Error).message
        : "Internal server error";

  const code = isTimeout
    ? "GATEWAY_TIMEOUT"
    : err instanceof AppError
      ? err.code
      : "INTERNAL_SERVER_ERROR";

  const details = err instanceof AppError ? err.details : undefined;

  if (status >= 500 && process.env.NODE_ENV !== "test") {
    console.error(`[error] ${req.method} ${req.path}`, err);
  }

  const payload: StandardErrorResponse = {
    error: {
      code,
      message,
      ...(details && details.length > 0 ? { details } : {}),
    },
  };

  res.status(status).json(payload);
};


