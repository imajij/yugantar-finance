/**
 * PRD 19.6 — the verification fixture for the five numbers.
 * If this fails, the views in 0001_views.sql no longer implement 6.2 / 6.3.
 */
import { afterAll, beforeAll, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { dropFests } from "@/lib/test-support";

const client = postgres(process.env.DATABASE_URL!, { max: 1 });
const db = drizzle(client);

const R = (rupees: number) => rupees * 100; // fixture is stated in rupees
let festId: string;
let lineItemId: string;
let deptId: string;

beforeAll(async () => {
  await db.execute(sql`
    insert into fests (name, slug, starts_on, ends_on, receipt_window_start, receipt_window_end, total_budget_paise)
    values ('Fixture Fest', 'fixture-' || gen_random_uuid(), '2026-11-27', '2026-11-29', '2026-09-28', '2026-12-14', ${R(500000)})
    returning id
  `).then((r) => { festId = (r as unknown as { id: string }[])[0].id; });

  const dept = await db.execute(sql`
    insert into departments (fest_id, name, slug, kind, allocated_paise)
    values (${festId}, 'Tech', 'tech', 'BUDGET', ${R(100000)}) returning id
  `);
  deptId = (dept as unknown as { id: string }[])[0].id;

  const user = await db.execute(sql`
    insert into users (fest_id, email, name, role, department_id, status)
    values (${festId}, 'fixture@example.test', 'Fixture User', 'DEPT_HOD', ${deptId}, 'ACTIVE') returning id
  `);
  const userId = (user as unknown as { id: string }[])[0].id;

  const et = await db.execute(sql`
    insert into expense_types (fest_id, name) values (${festId}, 'Equipment Rental') returning id
  `);
  const expenseTypeId = (et as unknown as { id: string }[])[0].id;

  const li = await db.execute(sql`
    insert into line_items (fest_id, department_id, name, planned_paise, created_by)
    values (${festId}, ${deptId}, 'Sound', ${R(60000)}, ${userId}) returning id
  `);
  lineItemId = (li as unknown as { id: string }[])[0].id;

  // Reimbursements on Sound, one per status the fixture names.
  const reimbursements: [string, number][] = [
    ["SUBMITTED", R(1000)], ["HOD_ENDORSED", R(2000)], ["APPROVED", R(3000)], ["ON_HOLD", R(500)],
    ["PAID", R(4000)], ["DECLINED", R(999)], ["SENT_BACK", R(777)], ["DRAFT", R(111)],
  ];
  let n = 0;
  for (const [status, amount] of reimbursements) {
    n += 1;
    await db.execute(sql`
      insert into reimbursement_requests
        (fest_id, human_id, department_id, line_item_id, expense_type_id, submitter_id,
         description, transaction_on, amount_paise, payee_name, payee_upi_id, status)
      values (${festId}, ${"RB-" + String(n).padStart(4, "0")}, ${deptId}, ${lineItemId}, ${expenseTypeId}, ${userId},
              ${"fixture row " + status}, '2026-11-27', ${amount}, 'Fixture Payee', 'fixture@upi',
              ${sql.raw(`'${status}'::reimbursement_status`)})
    `);
  }

  const vendor = await db.execute(sql`
    insert into vendors (fest_id, name, created_by) values (${festId}, 'Fixture Vendor', ${userId}) returning id
  `);
  const vendorId = (vendor as unknown as { id: string }[])[0].id;

  const vendorRequest = async (
    humanId: string, status: string, total: number, approved: number | null,
    milestones: { kind: string; planned: number; paid: number | null }[], refundReceived = 0,
  ) => {
    const vr = await db.execute(sql`
      insert into vendor_requests
        (fest_id, human_id, department_id, line_item_id, vendor_id, description,
         total_value_paise, approved_value_paise, status, requested_by, refund_received_paise)
      values (${festId}, ${humanId}, ${deptId}, ${lineItemId}, ${vendorId}, 'fixture vendor request',
              ${total}, ${approved}, ${sql.raw(`'${status}'::vendor_request_status`)}, ${userId}, ${refundReceived})
      returning id
    `);
    const vrId = (vr as unknown as { id: string }[])[0].id;
    for (const [i, m] of milestones.entries()) {
      await db.execute(sql`
        insert into vendor_milestones (vendor_request_id, kind, sort_order, planned_paise, paid_paise)
        values (${vrId}, ${sql.raw(`'${m.kind}'::milestone_kind`)}, ${i}, ${m.planned}, ${m.paid})
      `);
    }
  };

  await vendorRequest("VP-0001", "ADVANCE_PAID", R(20000), R(20000), [
    { kind: "ADVANCE", planned: R(10000), paid: R(10000) },
    { kind: "BALANCE", planned: R(10000), paid: null },
  ]);
  await vendorRequest("VP-0002", "SUBMITTED", R(5000), null, [
    { kind: "ADVANCE", planned: R(2500), paid: null },
    { kind: "BALANCE", planned: R(2500), paid: null },
  ]);
  await vendorRequest("VP-0003", "CANCELLED", R(8000), R(8000), [
    { kind: "ADVANCE", planned: R(2000), paid: R(2000) },
    { kind: "BALANCE", planned: R(6000), paid: null },
  ], R(500));

  const income = async (type: string, source: string, pledged: number, status: string, tranches: number[]) => {
    const e = await db.execute(sql`
      insert into income_entries (fest_id, type, source_name, pledged_paise, status, created_by)
      values (${festId}, ${sql.raw(`'${type}'::income_type`)}, ${source}, ${pledged},
              ${sql.raw(`'${status}'::income_status`)}, ${userId}) returning id
    `);
    const eId = (e as unknown as { id: string }[])[0].id;
    for (const amount of tranches) {
      await db.execute(sql`
        insert into income_tranches (income_entry_id, amount_paise, received_on, recorded_by)
        values (${eId}, ${amount}, '2026-10-01', ${userId})
      `);
    }
  };

  await income("SPONSORSHIP_CASH", "Sponsor A", R(30000), "PARTIALLY_RECEIVED", [R(10000)]);
  await income("SPONSORSHIP_IN_KIND", "Sponsor B", R(5000), "PLEDGED", []);
  await income("EVENT_TICKETS", "Gate day 1", 0, "RECEIVED", [R(2000)]);
  await income("SPONSORSHIP_CASH", "Sponsor C", R(4000), "WRITTEN_OFF", []);
});

afterAll(() => dropFests(db, "fixture-"));

test("line item Sound — pending / committed / spent / available", async () => {
  const rows = await db.execute<{ pending_paise: string; committed_paise: string; spent_paise: string; available_paise: string }>(
    sql`select * from v_line_item_totals where line_item_id = ${lineItemId}`,
  );
  const r = (rows as unknown as Record<string, string>[])[0];
  expect(Number(r.pending_paise)).toBe(R(8000));
  expect(Number(r.committed_paise)).toBe(R(13500));
  expect(Number(r.spent_paise)).toBe(R(15500));
  expect(Number(r.available_paise)).toBe(R(23000));
});

test("department Tech — planned / available", async () => {
  const rows = await db.execute(sql`select * from v_department_totals where department_id = ${deptId}`);
  const r = (rows as unknown as Record<string, string>[])[0];
  expect(Number(r.planned_paise)).toBe(R(60000));
  expect(Number(r.available_paise)).toBe(R(63000));
});

test("fest — income received / pledged / expected, cash position, projected close", async () => {
  const rows = await db.execute(sql`select * from v_fest_totals where fest_id = ${festId}`);
  const r = (rows as unknown as Record<string, string>[])[0];
  expect(Number(r.income_received_paise)).toBe(R(12000));
  expect(Number(r.income_pledged_paise)).toBe(R(30000));
  expect(Number(r.income_expected_paise)).toBe(R(32000));
  expect(Number(r.cash_position_paise)).toBe(R(-3500));
  expect(Number(r.projected_close_paise)).toBe(R(-5000));
});
