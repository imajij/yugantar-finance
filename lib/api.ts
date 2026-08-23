/**
 * Route-handler plumbing (PRD 20.1). Handlers parse, call `can`, call a service,
 * and respond — no business logic here or in them.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { ZodError, type ZodType } from "zod";
import { db } from "@/db";
import { idempotencyKeys } from "@/db/schema";
import { Forbidden } from "@/lib/authz";
import { InvalidTransition, ValidationError } from "@/lib/state-machines/types";
import { Unauthenticated, requireSession, type SessionUser } from "@/lib/session";

export type ErrorCode =
  | "VALIDATION_ERROR" | "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND"
  | "INVALID_TRANSITION" | "CONFLICT" | "OVER_ALLOCATION" | "RATE_LIMITED";

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INVALID_TRANSITION: 409,
  CONFLICT: 409,
  OVER_ALLOCATION: 409,
  RATE_LIMITED: 429,
};

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const notFound = (what = "Record") => new ApiError("NOT_FOUND", `${what} not found`);
export const overAllocation = (message: string, details?: Record<string, unknown>) =>
  new ApiError("OVER_ALLOCATION", message, details);
export const conflict = (message: string, details?: Record<string, unknown>) =>
  new ApiError("CONFLICT", message, details);

export function errorResponse(code: ErrorCode, message: string, details?: Record<string, unknown>) {
  return NextResponse.json({ error: { code, message, ...(details ? { details } : {}) } }, { status: STATUS[code] });
}

/** Maps every error the stack throws onto the 20.1 error shape. Nothing leaks a stack trace. */
export function toErrorResponse(error: unknown) {
  if (error instanceof ApiError) return errorResponse(error.code, error.message, error.details);
  if (error instanceof Unauthenticated) return errorResponse("UNAUTHENTICATED", error.message);
  if (error instanceof Forbidden) return errorResponse("FORBIDDEN", error.message);
  if (error instanceof InvalidTransition) return errorResponse("INVALID_TRANSITION", error.message);
  if (error instanceof ValidationError) return errorResponse("VALIDATION_ERROR", error.message, error.details);
  if (error instanceof ZodError) {
    return errorResponse("VALIDATION_ERROR", "Invalid request body", {
      issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  console.error("unhandled route error", error);
  return NextResponse.json(
    { error: { code: "INTERNAL", message: "Something went wrong" } },
    { status: 500 },
  );
}

export interface Ctx<P = Record<string, string>> {
  user: SessionUser;
  params: P;
  request: Request;
}

/**
 * Wraps a handler: resolves the session, awaits route params, maps errors.
 * `Idempotency-Key` is honoured when `idempotent` is set (18.2 rule 9).
 */
export function route<P extends Record<string, string> = Record<string, string>>(
  handler: (ctx: Ctx<P>) => Promise<Response | unknown>,
  options: { idempotent?: boolean } = {},
) {
  return async (request: Request, context: { params: Promise<P> } = { params: Promise.resolve({} as P) }) => {
    try {
      const user = await requireSession();
      const params = await context.params;

      const key = options.idempotent ? request.headers.get("Idempotency-Key") : null;
      if (key) {
        const replay = await replayIdempotent(key, user.id);
        if (replay) return NextResponse.json(replay);
      }

      const result = await handler({ user, params, request });
      // A handler that built its own Response (a CSV download, say) is returned as-is.
      if (result instanceof Response) return result;

      if (key) await storeIdempotent(key, user.id, result);
      return NextResponse.json(result);
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}

async function replayIdempotent(key: string, userId: string): Promise<unknown | null> {
  const [row] = await db
    .select({ response: idempotencyKeys.response, userId: idempotencyKeys.userId })
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.key, key))
    .limit(1);
  if (!row) return null;
  // A key belongs to the user who first used it; reuse by anyone else is a conflict.
  if (row.userId !== userId) throw conflict("Idempotency-Key already used by another user");
  return row.response;
}

async function storeIdempotent(key: string, userId: string, response: unknown): Promise<void> {
  await db
    .insert(idempotencyKeys)
    .values({ key, userId, response: response as object })
    .onConflictDoNothing();
}

/** Body parsing that produces the 20.1 VALIDATION_ERROR shape on failure. */
export async function parseBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    throw new ApiError("VALIDATION_ERROR", "Body must be JSON");
  }
  return schema.parse(json);
}

export function parseQuery<T>(request: Request, schema: ZodType<T>): T {
  const url = new URL(request.url);
  return schema.parse(Object.fromEntries(url.searchParams));
}

/** 20.1 list shape: `{ data, next_cursor }`. */
export function page<T>(data: T[], limit: number, cursorOf: (row: T) => string) {
  const hasMore = data.length > limit;
  const rows = hasMore ? data.slice(0, limit) : data;
  return { data: rows, next_cursor: hasMore ? cursorOf(rows[rows.length - 1]) : null };
}
