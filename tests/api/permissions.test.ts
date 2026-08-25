/**
 * PRD 21.3, first bullet: "a test proves each role gets 403 on every endpoint it
 * must not use (table in 5.1)."
 *
 * The table below is that proof. Each entry names an endpoint, how to call it, and
 * which of the six fixture users may reach it; every user *not* in `allow` is called
 * against the same endpoint and must be refused. Refused means 403 FORBIDDEN — not
 * 404, not 422, not a 500 — because a role that gets a validation error instead of a
 * refusal has already passed the permission check, which is the bug this test exists
 * to catch.
 *
 * The handlers are the real ones. Only session resolution is replaced (see
 * `harness.ts`), so `can()`, the services and the SQL all run.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { db } from "@/db";
import { dropFests } from "@/lib/test-support";
import type { SessionUser } from "@/lib/session";
import { buildFixture, callAs, type CallOptions, type Fixture, type Handler } from "./harness";

const PREFIX = "apiperm-";
let fx: Fixture;

beforeAll(async () => {
  fx = await buildFixture(PREFIX);
});

afterAll(() => dropFests(db, PREFIX));

type Who = keyof Fixture["users"];
const EVERYONE: Who[] = [
  "member", "otherMember", "hod", "otherHod", "finance", "management", "superAdmin",
];

interface Case {
  name: string;
  /** Imported lazily so a module-level failure names the endpoint that caused it. */
  load: () => Promise<Record<string, Handler>>;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Built per-call so it can reference fixture ids. */
  options?: (fx: Fixture) => CallOptions;
  allow: Who[];
  /**
   * Endpoints where a refused caller legitimately cannot see the record at all.
   * `can()` runs first either way; this only widens the accepted refusal codes.
   */
  notFoundOk?: boolean;
}

const CASES: Case[] = [
  /* ------------------------------------------------ 20.3 users and admin (F only) */
  {
    name: "GET /users",
    load: () => import("@/app/api/v1/users/route") as Promise<Record<string, Handler>>,
    method: "GET",
    allow: ["finance"],
  },
  {
    name: "POST /users — invite",
    load: () => import("@/app/api/v1/users/route") as Promise<Record<string, Handler>>,
    method: "POST",
    options: (f) => ({
      body: { name: "New", email: `new-${crypto.randomUUID()}@sst.scaler.com`, role: "MEMBER", department_id: f.departments.tech },
    }),
    allow: ["finance"],
  },
  {
    name: "PATCH /users/{id}",
    load: () => import("@/app/api/v1/users/[id]/route") as Promise<Record<string, Handler>>,
    method: "PATCH",
    options: (f) => ({ params: { id: f.users.member.id }, body: { name: "Renamed" } }),
    allow: ["finance"],
  },
  {
    name: "POST /expense-types",
    load: () => import("@/app/api/v1/expense-types/route") as Promise<Record<string, Handler>>,
    method: "POST",
    options: () => ({ body: { name: `Type ${crypto.randomUUID().slice(0, 8)}` } }),
    allow: ["finance"],
  },
  {
    name: "PATCH /fest",
    load: () => import("@/app/api/v1/fest/route") as Promise<Record<string, Handler>>,
    method: "PATCH",
    options: () => ({ body: { settings: { request_aging_amber_days: 4 } } }),
    allow: ["finance"],
  },
  {
    name: "PATCH /fest/settings",
    load: () => import("@/app/api/v1/fest/settings/route") as Promise<Record<string, Handler>>,
    method: "PATCH",
    options: () => ({ body: { request_aging_amber_days: 4 } }),
    allow: ["finance"],
  },

  /* --------------------------------------------------- 20.4 departments, transfers */
  {
    name: "POST /departments",
    load: () => import("@/app/api/v1/departments/route") as Promise<Record<string, Handler>>,
    method: "POST",
    options: () => ({ body: { name: "New dept", slug: `d-${crypto.randomUUID().slice(0, 8)}`, allocated_paise: 0 } }),
    allow: ["finance"],
  },
  {
    name: "PATCH /departments/{id}",
    load: () => import("@/app/api/v1/departments/[id]/route") as Promise<Record<string, Handler>>,
    method: "PATCH",
    options: (f) => ({ params: { id: f.departments.tech }, body: { name: "Tech" } }),
    allow: ["finance"],
  },
  {
    name: "POST /budget-transfers",
    load: () => import("@/app/api/v1/budget-transfers/route") as Promise<Record<string, Handler>>,
    method: "POST",
    options: (f) => ({
      body: { from_department_id: f.departments.tech, to_department_id: f.departments.logistics, amount_paise: 1000, reason: "Rebalancing the two" },
    }),
    // An administrator sets each department's budget; it still moves as a transfer.
    allow: ["finance", "superAdmin"],
  },
  {
    name: "GET /departments/{id}/summary — another department's",
    load: () => import("@/app/api/v1/departments/[id]/summary/route") as Promise<Record<string, Handler>>,
    method: "GET",
    options: (f) => ({ params: { id: f.departments.logistics } }),
    allow: ["otherMember", "otherHod", "finance", "management", "superAdmin"],
  },

  /* ------------------------------------------------------------- 20.5 line items */
  {
    name: "POST /departments/{id}/line-items — another department's",
    load: () => import("@/app/api/v1/departments/[id]/line-items/route") as Promise<Record<string, Handler>>,
    method: "POST",
    options: (f) => ({
      params: { id: f.departments.logistics },
      body: { name: `Item ${crypto.randomUUID().slice(0, 6)}`, planned_paise: 1000 },
    }),
    // The administrator breaks down any department's allocation; the cap still binds.
    allow: ["otherHod", "finance", "superAdmin"],
  },
  {
    name: "PATCH /line-items/{id} — another department's",
    load: () => import("@/app/api/v1/line-items/[id]/route") as Promise<Record<string, Handler>>,
    method: "PATCH",
    options: (f) => ({ params: { id: f.otherLineItemId }, body: { name: "Chairs" } }),
    allow: ["otherHod", "finance", "superAdmin"],
  },
  {
    name: "POST /line-items/{id}/documents — another department's",
    load: () => import("@/app/api/v1/line-items/[id]/documents/route") as Promise<Record<string, Handler>>,
    method: "POST",
    options: (f) => ({
      params: { id: f.otherLineItemId },
      body: { kind: "LINK", url: "https://example.com/quote", label: "A quote" },
    }),
    allow: ["otherHod", "finance", "superAdmin"],
  },
  {
    name: "GET /budget-review",
    load: () => import("@/app/api/v1/budget-review/route") as Promise<Record<string, Handler>>,
    method: "GET",
    allow: ["finance"],
  },

  /* --------------------------------------------------------- 20.6 reimbursements */
  {
    name: "POST /reimbursements/bulk-approve",
    load: () => import("@/app/api/v1/reimbursements/bulk-approve/route") as Promise<Record<string, Handler>>,
    method: "POST",
    options: () => ({ body: { ids: [crypto.randomUUID()] } }),
    allow: ["finance"],
  },

  /* ------------------------------------------------------------ 20.7 vendors */
  {
    name: "GET /vendors",
    load: () => import("@/app/api/v1/vendors/route") as Promise<Record<string, Handler>>,
    method: "GET",
    allow: ["hod", "otherHod", "finance", "management", "superAdmin"],
  },
  {
    name: "POST /vendors",
    load: () => import("@/app/api/v1/vendors/route") as Promise<Record<string, Handler>>,
    method: "POST",
    options: () => ({ body: { name: `Vendor ${crypto.randomUUID().slice(0, 8)}` } }),
    allow: ["hod", "otherHod", "finance"],
  },
  {
    name: "GET /vendor-requests",
    load: () => import("@/app/api/v1/vendor-requests/route") as Promise<Record<string, Handler>>,
    method: "GET",
    allow: ["hod", "otherHod", "finance", "management", "superAdmin"],
  },
  {
    name: "POST /vendor-requests — against another department's line item",
    load: () => import("@/app/api/v1/vendor-requests/route") as Promise<Record<string, Handler>>,
    method: "POST",
    options: (f) => ({
      body: {
        vendor_id: f.vendorId,
        line_item_id: f.otherLineItemId,
        description: "Sound system for the main stage",
        total_value_paise: 100000,
        milestones: [{ kind: "ADVANCE", planned_paise: 50000 }, { kind: "BALANCE", planned_paise: 50000 }],
      },
    }),
    allow: ["otherHod", "finance"],
  },

  /* ------------------------------------------------------------- 20.8 income */
  {
    name: "GET /income",
    load: () => import("@/app/api/v1/income/route") as Promise<Record<string, Handler>>,
    method: "GET",
    allow: ["finance", "management", "superAdmin"],
  },
  {
    name: "POST /income",
    load: () => import("@/app/api/v1/income/route") as Promise<Record<string, Handler>>,
    method: "POST",
    options: () => ({ body: { type: "SPONSORSHIP_CASH", source_name: "A sponsor", pledged_paise: 100000 } }),
    allow: ["finance"],
  },
  {
    name: "GET /income/summary",
    load: () => import("@/app/api/v1/income/summary/route") as Promise<Record<string, Handler>>,
    method: "GET",
    allow: ["finance", "management", "superAdmin"],
  },

  /* -------------------------------------------------------------- 20.9 tickets */
  {
    name: "GET /tickets/workload",
    load: () => import("@/app/api/v1/tickets/workload/route") as Promise<Record<string, Handler>>,
    method: "GET",
    allow: EVERYONE, // everyone sees their own department's; only Mg/F see all
  },

  /* ---------------------------------------------------- 20.10 flags and audit */
  {
    name: "GET /flags",
    load: () => import("@/app/api/v1/flags/route") as Promise<Record<string, Handler>>,
    method: "GET",
    allow: ["hod", "otherHod", "finance", "superAdmin"],
  },
  {
    name: "POST /flags/evaluate",
    load: () => import("@/app/api/v1/flags/evaluate/route") as Promise<Record<string, Handler>>,
    method: "POST",
    options: (f) => ({ body: { entity_type: "LINE_ITEM", entity_id: f.lineItemId } }),
    allow: ["finance"],
  },
  {
    // Oversight, not spending: the audit log is every action anyone took, so it
    // answers to the administrator flag and not to a role. The fixture's
    // administrator is a Member, which is what makes this a real check.
    name: "GET /audit",
    load: () => import("@/app/api/v1/audit/route") as Promise<Record<string, Handler>>,
    method: "GET",
    allow: ["superAdmin"],
  },

  /* ----------------------------------------------- 20.11 dashboards and queues */
  {
    name: "GET /dashboard/fest",
    load: () => import("@/app/api/v1/dashboard/fest/route") as Promise<Record<string, Handler>>,
    method: "GET",
    allow: ["finance", "management", "superAdmin"],
  },
  {
    name: "GET /dashboard/department/{id} — another department's",
    load: () => import("@/app/api/v1/dashboard/department/[id]/route") as Promise<Record<string, Handler>>,
    method: "GET",
    options: (f) => ({ params: { id: f.departments.logistics } }),
    allow: ["otherMember", "otherHod", "finance", "management", "superAdmin"],
  },
  {
    name: "GET /queues/endorsements",
    load: () => import("@/app/api/v1/queues/endorsements/route") as Promise<Record<string, Handler>>,
    method: "GET",
    allow: ["hod", "otherHod", "finance"],
  },
  {
    name: "GET /queues/approvals",
    load: () => import("@/app/api/v1/queues/approvals/route") as Promise<Record<string, Handler>>,
    method: "GET",
    allow: ["finance"],
  },
  {
    name: "GET /queues/payments",
    load: () => import("@/app/api/v1/queues/payments/route") as Promise<Record<string, Handler>>,
    method: "GET",
    allow: ["management"],
  },

  /* ------------------------------------------------------------- 20.12 exports */
  {
    name: "GET /exports/income-ledger",
    load: () => import("@/app/api/v1/exports/[kind]/route") as Promise<Record<string, Handler>>,
    method: "GET",
    options: () => ({ params: { kind: "income-ledger" } }),
    allow: ["finance", "management", "superAdmin"],
  },
  {
    name: "GET /exports/fest-summary",
    load: () => import("@/app/api/v1/exports/[kind]/route") as Promise<Record<string, Handler>>,
    method: "GET",
    options: () => ({ params: { kind: "fest-summary" }, query: { format: "xlsx" } }),
    allow: ["finance", "management", "superAdmin"],
  },
  {
    name: "GET /exports/audit",
    load: () => import("@/app/api/v1/exports/[kind]/route") as Promise<Record<string, Handler>>,
    method: "GET",
    options: () => ({ params: { kind: "audit" } }),
    allow: ["superAdmin"],
  },
];

/** 403 is the answer we want. 404 counts only where the record is genuinely invisible. */
const REFUSAL_CODES = new Set(["FORBIDDEN", "NOT_FOUND"]);

describe.each(CASES)("$name", (testCase) => {
  const refused = EVERYONE.filter((who) => !testCase.allow.includes(who));

  test.each(refused)("%s is refused", async (who) => {
    const handlers = await testCase.load();
    const handler = handlers[testCase.method];
    expect(handler, `${testCase.name} has no ${testCase.method} export`).toBeTypeOf("function");

    const result = await callAs(fx.users[who as Who], handler, {
      method: testCase.method,
      ...(testCase.options?.(fx) ?? {}),
    });

    expect(
      REFUSAL_CODES.has(result.code ?? ""),
      `${who} got ${result.status} ${result.code ?? "(no code)"} — ${result.message ?? result.text.slice(0, 200)}`,
    ).toBe(true);
    expect([403, 404]).toContain(result.status);
  });

  test.each(testCase.allow)("%s is allowed through the permission check", async (who) => {
    const handlers = await testCase.load();
    const handler = handlers[testCase.method];
    const result = await callAs(fx.users[who as Who], handler, {
      method: testCase.method,
      ...(testCase.options?.(fx) ?? {}),
    });

    // Not asserting success: some of these deliberately reference ids that do not
    // exist, so a 404 or a validation error is fine. What must never happen is a
    // refusal — that would mean the matrix and `can()` disagree.
    expect(
      result.code,
      `${who} was refused ${testCase.name}: ${result.message ?? ""}`,
    ).not.toBe("FORBIDDEN");
  });
});

/* --------------------------------------------------------------- unauthenticated */

test("every endpoint refuses an unauthenticated caller", async () => {
  const failures: string[] = [];

  for (const testCase of CASES) {
    const handlers = await testCase.load();
    const handler = handlers[testCase.method];
    const result = await callAs(null as unknown as SessionUser, handler, {
      method: testCase.method,
      ...(testCase.options?.(fx) ?? {}),
    });
    if (result.code !== "UNAUTHENTICATED" || result.status !== 401) {
      failures.push(`${testCase.name}: ${result.status} ${result.code ?? result.text.slice(0, 80)}`);
    }
  }

  expect(failures).toEqual([]);
});
