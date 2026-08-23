/**
 * PRD 7.4 / 6.3 — income. Status is derived from the tranches, never typed in, and
 * in-kind sponsorship is excluded from the cash position by the view, not by JS.
 */
import { beforeEach, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { Actor } from "@/lib/authz";
import { rupeesToPaise as R } from "@/lib/money";
import {
  createIncome, incomeLedger, recordTranche, sponsorStatement, transitionIncome,
} from "@/lib/services/income";
import { festTotals, incomeTotalsByType } from "@/lib/queries/budget";

let festId: string, techId: string, financeDeptId: string, coreId: string;
let finance: Actor, techHod: Actor, mgmt: Actor;

async function one<T extends Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T> {
  return ((await db.execute(q)) as unknown as T[])[0];
}

beforeEach(async () => {
  festId = (await one<{ id: string }>(sql`
    insert into fests (name, slug, starts_on, ends_on, receipt_window_start, receipt_window_end,
                       total_budget_paise, settings)
    values ('Income Fest', 'inc-' || gen_random_uuid(), '2026-11-27','2026-11-29','2026-09-28','2026-12-14',
            ${R(1000000)}, '{"flag_thresholds": {"income_followup_days": 30}}'::jsonb)
    returning id`)).id;

  const mkDept = async (name: string, slug: string, kind: string) =>
    (await one<{ id: string }>(sql`
      insert into departments (fest_id, name, slug, kind, allocated_paise)
      values (${festId}, ${name}, ${slug}, ${sql.raw(`'${kind}'::department_kind`)}, 0) returning id`)).id;

  financeDeptId = await mkDept("Finance", "finance", "FINANCE");
  coreId = await mkDept("Core", "core", "CORE");
  techId = await mkDept("Tech", "tech", "BUDGET");

  const mkUser = async (email: string, role: Actor["role"], deptId: string): Promise<Actor> => ({
    id: (await one<{ id: string }>(sql`
      insert into users (fest_id, email, name, role, department_id, status)
      values (${festId}, ${email}, ${email}, ${sql.raw(`'${role}'::user_role`)}, ${deptId}, 'ACTIVE') returning id`)).id,
    festId, role, departmentId: deptId,
  });

  finance = await mkUser("fin@i.test", "FINANCE_HOD", financeDeptId);
  techHod = await mkUser("hod@i.test", "DEPT_HOD", techId);
  mgmt = await mkUser("mg@i.test", "MANAGEMENT", coreId);
});

test("status follows the money: pledged, partly received, then received", async () => {
  const e = await createIncome(finance, {
    type: "SPONSORSHIP_CASH", sourceName: "Acme Corp",
    pledgedPaise: R(100000), pledgedOn: "2026-09-01",
  });
  expect(e.status).toBe("PLEDGED");

  await recordTranche(finance, e.id, { amountPaise: R(40000), receivedOn: "2026-09-15", reference: "UTR-1" });
  let [row] = await incomeLedger(finance);
  expect(row.status).toBe("PARTIALLY_RECEIVED");
  expect(row.receivedPaise).toBe(R(40000));
  expect(row.outstandingPaise).toBe(R(60000));

  await recordTranche(finance, e.id, { amountPaise: R(60000), receivedOn: "2026-10-01", reference: "UTR-2" });
  [row] = await incomeLedger(finance);
  expect(row.status).toBe("RECEIVED");
  expect(row.outstandingPaise).toBe(0);
});

test("in-kind sponsorship is recorded but kept out of the cash position", async () => {
  await createIncome(finance, { type: "SPONSORSHIP_CASH", sourceName: "Cash Co", pledgedPaise: R(100000) });
  const kind = await createIncome(finance, {
    type: "SPONSORSHIP_IN_KIND", sourceName: "Merch Partner", pledgedPaise: R(50000),
  });
  await recordTranche(finance, kind.id, { amountPaise: R(50000), receivedOn: "2026-10-01" });

  const totals = await festTotals(festId);
  expect(totals!.incomeReceivedPaise).toBe(0);        // the in-kind delivery is not cash

  const byType = await incomeTotalsByType(festId);
  const inKind = byType.find((t) => t.type === "SPONSORSHIP_IN_KIND")!;
  expect(inKind.receivedPaise).toBe(R(50000));        // still recorded, just not counted
});

test("cash income raises the cash position and the projected close", async () => {
  const e = await createIncome(finance, {
    type: "SPONSORSHIP_CASH", sourceName: "Acme", pledgedPaise: R(100000), pledgedOn: "2026-09-01",
  });
  await recordTranche(finance, e.id, { amountPaise: R(70000), receivedOn: "2026-09-20" });

  const t = await festTotals(festId);
  expect(t!.incomeReceivedPaise).toBe(R(70000));
  // "Expected" is the whole pledge, not the remainder — see v_income_totals.
  expect(t!.incomeExpectedPaise).toBe(R(100000));
  expect(t!.cashPositionPaise).toBe(R(70000));        // nothing spent yet
  expect(t!.projectedClosePaise).toBe(R(100000));     // if the rest lands
});

test("an unreceived pledge past the follow-up window is marked overdue", async () => {
  await createIncome(finance, {
    type: "SPONSORSHIP_CASH", sourceName: "Slow Payer",
    pledgedPaise: R(50000),
    pledgedOn: new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10),
  });
  await createIncome(finance, {
    type: "SPONSORSHIP_CASH", sourceName: "Recent",
    pledgedPaise: R(50000),
    pledgedOn: new Date(Date.now() - 5 * 864e5).toISOString().slice(0, 10),
  });

  const ledger = await incomeLedger(finance);
  expect(ledger.find((e) => e.sourceName === "Slow Payer")!.overdue).toBe(true);
  expect(ledger.find((e) => e.sourceName === "Recent")!.overdue).toBe(false);

  const onlyOverdue = await incomeLedger(finance, { overdue: true });
  expect(onlyOverdue.map((e) => e.sourceName)).toEqual(["Slow Payer"]);
});

test("writing off needs a reason, and reinstating restores the derived status", async () => {
  const e = await createIncome(finance, {
    type: "SPONSORSHIP_CASH", sourceName: "Ghost Sponsor", pledgedPaise: R(80000),
  });
  await recordTranche(finance, e.id, { amountPaise: R(20000), receivedOn: "2026-09-10" });

  await expect(transitionIncome(finance, e.id, "WRITE_OFF")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

  const off = await transitionIncome(finance, e.id, "WRITE_OFF", "stopped answering the phone");
  expect(off.status).toBe("WRITTEN_OFF");
  await expect(recordTranche(finance, e.id, { amountPaise: R(1000), receivedOn: "2026-10-01" }))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR" });

  await transitionIncome(finance, e.id, "REINSTATE");
  const [row] = await incomeLedger(finance);
  expect(row.status).toBe("PARTIALLY_RECEIVED");     // recomputed from the one tranche
});

test("Finance records income; Management may look but not touch", async () => {
  await expect(createIncome(techHod, { type: "OTHER", sourceName: "x", pledgedPaise: R(100) }))
    .rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(incomeLedger(techHod)).rejects.toMatchObject({ code: "FORBIDDEN" });

  // Management oversees the numbers but does not enter them (5.1).
  await expect(createIncome(mgmt, { type: "COLLEGE_GRANT", sourceName: "College", pledgedPaise: R(200000) }))
    .rejects.toMatchObject({ code: "FORBIDDEN" });

  const e = await createIncome(finance, { type: "COLLEGE_GRANT", sourceName: "College", pledgedPaise: R(200000) });
  expect(e.sourceName).toBe("College");
  expect((await incomeLedger(mgmt)).map((r) => r.sourceName)).toContain("College");
});

test("the sponsor statement lists every tranche with who recorded it", async () => {
  const e = await createIncome(finance, {
    type: "SPONSORSHIP_CASH", sourceName: "Acme", pledgedPaise: R(100000),
  });
  await recordTranche(finance, e.id, { amountPaise: R(40000), receivedOn: "2026-09-15", reference: "UTR-1" });
  await recordTranche(finance, e.id, { amountPaise: R(25000), receivedOn: "2026-10-05", reference: "UTR-2" });

  const s = await sponsorStatement(finance, e.id);
  expect(s.receivedPaise).toBe(R(65000));
  expect(s.outstandingPaise).toBe(R(35000));
  expect(s.tranches.map((t) => t.recordedBy)).toEqual(["fin@i.test", "fin@i.test"]);
});
