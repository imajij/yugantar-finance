/**
 * PRD 18.2 rule 10: "every query is scoped by the caller's `fest_id`".
 *
 * The rule exists because a UUID is not a secret. It appears in URLs, in exports, in
 * emails, in anything anyone screenshots — so the only thing standing between one
 * fest's finances and another's is that every lookup carries `fest_id` in its WHERE
 * clause. A single query that forgets is a data breach with no error message.
 *
 * So this builds two complete fests and, as the *most* privileged person in one — an
 * administrator, who sees everything in their own fest by design — reaches for the
 * other's records by their real ids. Every one must come back refused.
 *
 * Using the strongest role is the point. A Member being refused proves little; an
 * administrator being refused proves the boundary is the fest and not the permission.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { dropFests } from "@/lib/test-support";
import { buildFixture, callAs, type Fixture, type Handler } from "./harness";

const PREFIX = "apiiso-";
let mine: Fixture;
let theirs: Fixture;

beforeAll(async () => {
  mine = await buildFixture(PREFIX);
  theirs = await buildFixture(PREFIX);
  // The caller is an administrator in their own fest: every permission `can()` grants,
  // and none of it should reach across.
  await db.execute(sql`update users set is_super_admin = true where id = ${mine.users.finance.id}`);
  mine.users.finance.isSuperAdmin = true;
});

afterAll(() => dropFests(db, PREFIX));

const load = (path: string) => import(`@/app/api/v1/${path}/route`) as Promise<Record<string, Handler>>;

/** Refused, however the endpoint chooses to say so. Never 200. */
const REFUSAL = ["NOT_FOUND", "FORBIDDEN", "VALIDATION_ERROR", "INVALID_TRANSITION"];

interface Reach {
  name: string;
  path: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Built from the *other* fest's ids. */
  options: (other: Fixture) => { params?: Record<string, string>; body?: unknown; query?: Record<string, string> };
}

const REACHES: Reach[] = [
  {
    name: "read another fest's line item",
    path: "line-items/[id]", method: "GET",
    options: (o) => ({ params: { id: o.lineItemId } }),
  },
  {
    name: "edit another fest's line item",
    path: "line-items/[id]", method: "PATCH",
    options: (o) => ({ params: { id: o.lineItemId }, body: { name: "Renamed by an outsider" } }),
  },
  {
    name: "close another fest's line item",
    path: "line-items/[id]/transitions", method: "POST",
    options: (o) => ({ params: { id: o.lineItemId }, body: { action: "CLOSE", reason: "Not mine to close" } }),
  },
  {
    name: "attach a document to another fest's line item",
    path: "line-items/[id]/documents", method: "POST",
    options: (o) => ({
      params: { id: o.lineItemId },
      body: { kind: "LINK", url: "https://example.com/q", label: "Q" },
    }),
  },
  {
    name: "read another fest's department summary",
    path: "departments/[id]/summary", method: "GET",
    options: (o) => ({ params: { id: o.departments.tech } }),
  },
  {
    name: "rename another fest's department",
    path: "departments/[id]", method: "PATCH",
    options: (o) => ({ params: { id: o.departments.tech }, body: { name: "Taken over" } }),
  },
  {
    name: "create a line item in another fest's department",
    path: "departments/[id]/line-items", method: "POST",
    options: (o) => ({ params: { id: o.departments.tech }, body: { name: "Sneaked in", planned_paise: 1000 } }),
  },
  {
    name: "read another fest's department dashboard",
    path: "dashboard/department/[id]", method: "GET",
    options: (o) => ({ params: { id: o.departments.tech } }),
  },
  {
    name: "move another fest's budget",
    path: "budget-transfers", method: "POST",
    options: (o) => ({
      body: {
        from_department_id: o.departments.tech,
        to_department_id: o.departments.logistics,
        amount_paise: 1000,
        reason: "Moving money that is not mine",
      },
    }),
  },
  {
    name: "read another fest's vendor",
    path: "vendors/[id]", method: "GET",
    options: (o) => ({ params: { id: o.vendorId } }),
  },
  {
    name: "edit another fest's vendor",
    path: "vendors/[id]", method: "PATCH",
    options: (o) => ({ params: { id: o.vendorId }, body: { contact_name: "Changed" } }),
  },
  {
    name: "promote a user in another fest",
    path: "users/[id]", method: "PATCH",
    options: (o) => ({ params: { id: o.users.member.id }, body: { role: "FINANCE_HOD" } }),
  },
  {
    name: "make a user in another fest an administrator",
    path: "users/[id]", method: "PATCH",
    options: (o) => ({ params: { id: o.users.member.id }, body: { is_super_admin: true } }),
  },
  {
    name: "deactivate a user in another fest",
    path: "users/[id]", method: "PATCH",
    options: (o) => ({ params: { id: o.users.member.id }, body: { status: "DISABLED" } }),
  },
  {
    name: "deactivate another fest's expense type",
    path: "expense-types/[id]", method: "PATCH",
    options: (o) => ({ params: { id: o.expenseTypeId }, body: { is_active: false } }),
  },
  {
    name: "comment on another fest's record",
    path: "comments", method: "POST",
    options: (o) => ({ body: { entity_type: "LINE_ITEM", entity_id: o.lineItemId, body: "Reading your books" } }),
  },
  {
    name: "read another fest's comment thread",
    path: "comments", method: "GET",
    options: (o) => ({ query: { entity_type: "LINE_ITEM", entity_id: o.lineItemId } }),
  },
  {
    name: "re-run flags on another fest's record",
    path: "flags/evaluate", method: "POST",
    options: (o) => ({ body: { entity_type: "LINE_ITEM", entity_id: o.lineItemId } }),
  },

  {
    name: "ask for another fest's department budget",
    path: "allocation-requests", method: "POST",
    options: (o) => ({
      body: { department_id: o.departments.tech, requested_paise: 500000, reason: "Taking their budget" },
    }),
  },
  {
    name: "decide another fest's allocation request",
    path: "allocation-requests/[id]/decision", method: "POST",
    options: (o) => ({ params: { id: o.lineItemId }, body: { decision: "APPROVE", note: "Not mine" } }),
  },
  {
    name: "withdraw another fest's allocation request",
    path: "allocation-requests/[id]", method: "DELETE",
    options: (o) => ({ params: { id: o.lineItemId } }),
  },
  {
    name: "retire another fest's vendor",
    path: "vendors/[id]", method: "DELETE",
    options: (o) => ({ params: { id: o.vendorId } }),
  },
  {
    name: "flag another fest's department",
    path: "flags", method: "POST",
    options: (o) => ({
      body: {
        entity_type: "DEPARTMENT", entity_id: o.departments.tech,
        severity: "HIGH", explanation: "Reaching across the fest boundary here",
      },
    }),
  },
  {
    name: "flag somebody in another fest",
    path: "flags", method: "POST",
    options: (o) => ({
      body: {
        entity_type: "USER", entity_id: o.users.member.id,
        severity: "HIGH", explanation: "Reaching across the fest boundary here",
      },
    }),
  },
  {
    name: "rename another fest's label",
    path: "ticket-labels/[id]", method: "PATCH",
    options: (o) => ({ params: { id: o.lineItemId }, body: { name: "Taken over" } }),
  },
  {
    name: "delete another fest's project",
    path: "projects/[id]", method: "DELETE",
    options: (o) => ({ params: { id: o.lineItemId } }),
  },
  {
    name: "delete another fest's cycle",
    path: "cycles/[id]", method: "DELETE",
    options: (o) => ({ params: { id: o.lineItemId } }),
  },
  {
    name: "export another fest's department statement",
    path: "exports/[kind]", method: "GET",
    options: (o) => ({ params: { kind: "department-statement" }, query: { id: o.departments.tech, format: "csv" } }),
  },
];

describe("a fest cannot reach into another", () => {
  test.each(REACHES)("$name", async ({ path, method, options }) => {
    const handlers = await load(path);
    const handler = handlers[method];
    expect(handler, `${method} ${path} does not exist`).toBeTypeOf("function");

    const result = await callAs(mine.users.finance, handler, { method, ...options(theirs) });

    expect(
      result.status,
      `an administrator of another fest was served: ${result.text.slice(0, 160)}`,
    ).not.toBe(200);
    expect(
      REFUSAL.includes(result.code ?? ""),
      `expected a refusal, got ${result.status} ${result.code ?? result.text.slice(0, 120)}`,
    ).toBe(true);
  });
});

test("a filtered list scoped to another fest's record comes back empty", async () => {
  // A list refuses by returning nothing, not by erroring — the WHERE clause carries
  // `fest_id`, so a foreign filter simply matches no rows. Empty is the proof.
  const handlers = await load("audit");
  const result = await callAs(mine.users.finance, handlers.GET, {
    query: { entity_id: theirs.lineItemId },
  });
  expect(result.status).toBe(200);
  expect(result.json!.data).toEqual([]);
});

describe("and nothing leaks through a listing", () => {
  test("lists carry only this fest's rows", async () => {
    for (const [path, pluck] of [
      ["reimbursements", (j: Record<string, unknown>) => j.data],
      ["vendors", (j: Record<string, unknown>) => j.data],
      ["vendor-requests", (j: Record<string, unknown>) => j.data],
      ["income", (j: Record<string, unknown>) => j.data],
      ["departments", (j: Record<string, unknown>) => j.data],
      ["flags", (j: Record<string, unknown>) => j.data],
      ["audit", (j: Record<string, unknown>) => j.data],
      ["allocation-requests", (j: Record<string, unknown>) => j.data],
      ["ticket-labels", (j: Record<string, unknown>) => j.data],
      ["projects", (j: Record<string, unknown>) => j.data],
      ["cycles", (j: Record<string, unknown>) => j.data],
    ] as const) {
      const handlers = await load(path);
      const result = await callAs(mine.users.finance, handlers.GET, {});
      expect(result.status, path).toBe(200);

      const serialised = JSON.stringify(pluck(result.json!) ?? []);
      // The other fest's ids must not appear anywhere in the payload.
      for (const foreign of [
        theirs.festId, theirs.departments.tech, theirs.lineItemId,
        theirs.vendorId, theirs.users.member.id,
      ]) {
        expect(serialised.includes(foreign), `${path} leaked ${foreign}`).toBe(false);
      }
    }
  });

  test("the fest dashboard totals only this fest", async () => {
    const handlers = await load("dashboard/fest");
    const result = await callAs(mine.users.finance, handlers.GET, {});
    expect(result.status).toBe(200);
    expect(JSON.stringify(result.json)).not.toContain(theirs.departments.tech);
  });
});
