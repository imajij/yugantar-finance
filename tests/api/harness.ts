/**
 * Route-handler tests (PRD 21.3: "a test proves each role gets 403 on every endpoint
 * it must not use").
 *
 * These call the real handlers in-process — the same `route()` wrapper, the same
 * `can()`, the same services and SQL — with only the session resolution replaced.
 * That is the one thing a test cannot supply honestly: everything downstream of it
 * is exercised for real, which is the point. A test that mocked the services would
 * prove the mocks agree with each other and nothing about the permission matrix.
 */
import { sql } from "drizzle-orm";
import { vi } from "vitest";
import { db } from "@/db";
import type { SessionUser } from "@/lib/session";
import type { Role } from "@/lib/state-machines/types";

/* ---------------------------------------------------------------- the session */

let current: SessionUser | null = null;

/** Whoever `requireSession()` will hand back for the next call. */
export function actAs(user: SessionUser | null): void {
  current = user;
}

/**
 * Installed by `tests/api/setup.ts` before any handler is imported. `requireSession`
 * reads cookies, which do not exist outside a request; this is the seam.
 */
export function installSessionMock(): void {
  vi.mock("@/lib/session", async (importOriginal) => {
    const original = await importOriginal<typeof import("@/lib/session")>();
    return {
      ...original,
      getSession: async () => current,
      requireSession: async () => {
        if (!current) throw new original.Unauthenticated();
        return current;
      },
    };
  });
}

/* ----------------------------------------------------------------- the fixture */

export interface Fixture {
  festId: string;
  departments: Record<"tech" | "logistics" | "finance" | "core", string>;
  users: Record<
    "member" | "otherMember" | "hod" | "otherHod" | "finance" | "management",
    SessionUser
  >;
  lineItemId: string;
  otherLineItemId: string;
  /** On the Finance department, so a Finance HOD can spend their own budget. */
  financeLineItemId: string;
  expenseTypeId: string;
  vendorId: string;
}

const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T> =>
  ((await db.execute(q)) as unknown as T[])[0];

/** A whole fest, one user per role, plus a second department to test cross-scope. */
export async function buildFixture(slugPrefix: string): Promise<Fixture> {
  const { id: festId } = await one<{ id: string }>(sql`
    insert into fests (name, slug, starts_on, ends_on, receipt_window_start, receipt_window_end,
                       total_budget_paise, settings)
    values ('API Fest', ${`${slugPrefix}${crypto.randomUUID()}`},
            '2026-11-27','2026-11-29','2026-09-28','2026-12-14', 100000000,
            '{"line_item_doc_threshold_paise": 1000000}'::jsonb)
    returning id`);

  const dept = async (name: string, slug: string, kind: string, allocated = 0) =>
    (await one<{ id: string }>(sql`
      insert into departments (fest_id, name, slug, kind, allocated_paise)
      values (${festId}, ${name}, ${slug}, ${sql.raw(`'${kind}'::department_kind`)}, ${allocated})
      returning id`)).id;

  const departments = {
    tech: await dept("Tech", "tech", "BUDGET", 5000000),
    logistics: await dept("Logistics", "logistics", "BUDGET", 3000000),
    finance: await dept("Finance", "finance", "FINANCE"),
    core: await dept("Core", "core", "CORE"),
  };

  const user = async (
    name: string, local: string, role: Role, departmentId: string,
  ): Promise<SessionUser> => {
    // Unique per run so parallel test files do not collide on `users_fest_email`.
    // The address is returned exactly as stored — a fixture whose `email` differs
    // from the row is a fixture that lies to any test that signs in with it.
    const email = `${local}-${crypto.randomUUID()}@sst.scaler.com`;
    const row = await one<{ id: string }>(sql`
      insert into users (fest_id, name, email, role, department_id, status, upi_id)
      values (${festId}, ${name}, ${email},
              ${sql.raw(`'${role}'::user_role`)}, ${departmentId}, 'ACTIVE', 'x@upi')
      returning id`);
    return {
      id: row.id, festId, role, departmentId,
      name, email, departmentName: "d", departmentKind: "BUDGET",
      upiId: "x@upi", status: "ACTIVE",
    };
  };

  const users = {
    member: await user("Tech Member", "tech-member", "MEMBER", departments.tech),
    otherMember: await user("Logi Member", "logi-member", "MEMBER", departments.logistics),
    hod: await user("Tech HOD", "tech-hod", "DEPT_HOD", departments.tech),
    otherHod: await user("Logi HOD", "logi-hod", "DEPT_HOD", departments.logistics),
    finance: await user("Finance HOD", "finance-hod", "FINANCE_HOD", departments.finance),
    management: await user("Management", "management", "MANAGEMENT", departments.core),
  };

  const { id: expenseTypeId } = await one<{ id: string }>(sql`
    insert into expense_types (fest_id, name) values (${festId}, 'Equipment') returning id`);

  /**
   * A line item, with a quotation on it. The document threshold (21.4) is a hard
   * block: a ₹20,000 line item with nothing supporting it cannot receive requests
   * at all, so a fixture without the quote would test that block and nothing else.
   */
  const lineItem = async (departmentId: string, name: string) => {
    const { id } = await one<{ id: string }>(sql`
      insert into line_items (fest_id, department_id, name, planned_paise, created_by)
      values (${festId}, ${departmentId}, ${name}, 2000000, ${users.finance.id})
      returning id`);
    await db.execute(sql`
      insert into attachments (fest_id, entity_type, entity_id, purpose, kind, url,
                               label, source_name, quoted_amount_paise, uploaded_by)
      values (${festId}, 'LINE_ITEM', ${id}, 'QUOTE', 'LINK', 'https://example.com/quote',
              ${`Quotation — ${name}`}, 'ABC Sound', 1900000, ${users.finance.id})`);
    return id;
  };

  const { id: vendorId } = await one<{ id: string }>(sql`
    insert into vendors (fest_id, name, created_by, bank_account_number, bank_ifsc, upi_id)
    values (${festId}, 'ABC Sound', ${users.finance.id}, '123456789012', 'HDFC0001234', 'abc@upi')
    returning id`);

  return {
    festId,
    departments,
    users,
    lineItemId: await lineItem(departments.tech, "Sound"),
    otherLineItemId: await lineItem(departments.logistics, "Chairs"),
    financeLineItemId: await lineItem(departments.finance, "Office supplies"),
    expenseTypeId,
    vendorId,
  };
}

/* ------------------------------------------------------------- calling handlers */

export type Handler = (
  request: Request,
  context?: { params: Promise<Record<string, string>> },
) => Promise<Response>;

export interface CallOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  params?: Record<string, string>;
  query?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface CallResult {
  status: number;
  /** The 20.1 error code, when the response is an error. */
  code?: string;
  message?: string;
  json: Record<string, unknown> | null;
  text: string;
}

export async function call(handler: Handler, opts: CallOptions = {}): Promise<CallResult> {
  const url = new URL("http://test.local/api/v1/x");
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

  const request = new Request(url, {
    method: opts.method ?? "GET",
    headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });

  const response = await handler(request, { params: Promise.resolve(opts.params ?? {}) });
  const text = await response.text();

  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    // A CSV or XLSX download: not JSON, and that is fine.
  }

  const error = (json?.error ?? null) as { code?: string; message?: string } | null;
  return { status: response.status, code: error?.code, message: error?.message, json, text };
}

/** `call`, as a specific user. The two always travel together. */
export async function callAs(user: SessionUser | null, handler: Handler, opts: CallOptions = {}) {
  actAs(user);
  try {
    return await call(handler, opts);
  } finally {
    actAs(null);
  }
}
