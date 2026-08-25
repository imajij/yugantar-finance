/**
 * Route-handler plumbing (PRD 20.1). Handlers parse, call `can`, call a service,
 * and respond — no business logic here or in them.
 */
import { NextResponse, after } from "next/server";
import { eq } from "drizzle-orm";
import { ZodError, type ZodType } from "zod";
import { db } from "@/db";
import { idempotencyKeys } from "@/db/schema";
import { Forbidden } from "@/lib/authz";
import { InvalidTransition, ValidationError } from "@/lib/state-machines/types";
import { Unauthenticated, requireSession, type SessionUser } from "@/lib/session";
import { enforce } from "@/lib/rate-limit";
import { flushOutbox } from "@/lib/services/notifications";

export type ErrorCode =
  | "VALIDATION_ERROR" | "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND"
  | "INVALID_TRANSITION" | "CONFLICT" | "OVER_ALLOCATION" | "RATE_LIMITED"
  // Beyond PRD 20.1's list: the request was fine, the deployment is not. A missing
  // environment variable surfacing as "Something went wrong" costs an afternoon,
  // and the operator is the one who needs to be told.
  | "NOT_CONFIGURED";

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INVALID_TRANSITION: 409,
  CONFLICT: 409,
  OVER_ALLOCATION: 409,
  RATE_LIMITED: 429,
  NOT_CONFIGURED: 503,
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

/**
 * Thrown where the code cannot proceed because the deployment is missing something.
 * Carries what to set, because whoever sees it is an operator, not an attacker —
 * and naming an environment variable gives nothing away.
 */
export class NotConfigured extends ApiError {
  constructor(what: string, fix: string) {
    super("NOT_CONFIGURED", `${what} is not configured on this deployment.`, { fix });
    this.name = "NotConfigured";
  }
}

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
 * The largest body any endpoint here has a use for.
 *
 * Every payload is a form: a description, some ids, an amount. Files never come
 * through the API — they go straight to storage on a presigned URL (20.2) — so
 * nothing legitimate approaches this. Without a ceiling, one request can make the
 * server parse as much JSON as somebody cares to send.
 */
const MAX_BODY_BYTES = 128 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Route params that name a record must look like one.
 *
 * Every id in this app is a UUID, and Postgres rejects anything else with `invalid
 * input syntax for type uuid` — which arrives as a 500. That is wrong twice: a
 * malformed id is the caller's mistake, not the server's, and a 500 says a database
 * error happened where "no such record" is both truer and quieter. It also means
 * anyone can fill the error log by typing nonsense into a URL.
 *
 * Checked by convention — `id`, or anything ending in `Id` — which covers every
 * dynamic segment in `app/api` (`id`, `attachmentId`, `userId`) and deliberately
 * leaves `kind` alone, since that one is a name and its route validates it itself.
 */
function assertParamsWellFormed(params: Record<string, string> | undefined): void {
  // A route with no dynamic segments is handed no params at all, not an empty object.
  for (const [name, value] of Object.entries(params ?? {})) {
    if (name !== "id" && !name.endsWith("Id")) continue;
    if (!UUID.test(value)) throw notFound();
  }
}

/**
 * Wraps a handler: resolves the session, awaits route params, maps errors.
 * `Idempotency-Key` is honoured when `idempotent` is set (18.2 rule 9).
 *
 * Writes are additionally rate limited per user. The limit is far above anything a
 * person does by hand — it is there so that a loop, a stuck retry or a stolen session
 * cannot grind through the database unchecked.
 */
export function route<P extends Record<string, string> = Record<string, string>>(
  handler: (ctx: Ctx<P>) => Promise<Response | unknown>,
  options: { idempotent?: boolean } = {},
) {
  return async (request: Request, context: { params: Promise<P> } = { params: Promise.resolve({} as P) }) => {
    try {
      const user = await requireSession();
      const params = (await context.params) ?? ({} as P);
      assertParamsWellFormed(params);

      const isWrite = request.method !== "GET" && request.method !== "HEAD";
      if (isWrite) await enforce("write", user.id);

      const key = options.idempotent ? request.headers.get("Idempotency-Key") : null;
      if (key) {
        const replay = await replayIdempotent(key, user.id);
        if (replay) return NextResponse.json(replay);
      }

      const result = await handler({ user, params, request });

      // Notifications are written inside the same transaction as the write that
      // caused them, then delivered here — after the response, so a slow mail
      // provider costs the user nothing and a failed send costs them nothing either
      // (the row stays unsent and the sweep retries it).
      if (request.method !== "GET" && request.method !== "HEAD") {
        after(async () => {
          try {
            await flushOutbox();
          } catch (error) {
            console.error("[outbox] flush failed", error);
          }
        });
      }

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

/**
 * Body parsing that produces the 20.1 VALIDATION_ERROR shape on failure.
 *
 * The size check reads the text first rather than trusting `Content-Length`, which a
 * client sets and can lie about. Parsing is what costs; refusing before it is the
 * point.
 */
export async function parseBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new ApiError("VALIDATION_ERROR", "Could not read the request body");
  }

  if (text.length > MAX_BODY_BYTES) {
    throw new ApiError("VALIDATION_ERROR", `Request body must be under ${MAX_BODY_BYTES / 1024} KB`, {
      received_bytes: text.length,
      limit_bytes: MAX_BODY_BYTES,
    });
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
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
