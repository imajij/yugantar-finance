/**
 * The reimbursement ledger as a spreadsheet (PRD 12).
 *
 * The whole risk in this feature is scope. A screen showing the wrong rows is a bug
 * somebody notices and closes; a *file* showing the wrong rows leaves the building
 * with every payee's UPI id in it and cannot be recalled. So most of what is below
 * asks the same question from four seats: how much of the ledger does this person
 * get to take away?
 *
 * The answer has to match the Reimbursements screen exactly, because that is what
 * the button next to it appears to be exporting.
 */
import { afterAll, beforeEach, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { Actor } from "@/lib/authz";
import { dropFests } from "@/lib/test-support";
import { publicBillUrl } from "@/lib/services/attachments";
import { runExport } from "@/lib/services/exports";
import { createReimbursement, transitionReimbursement } from "@/lib/services/reimbursements";
import { rupeesToPaise as R } from "@/lib/money";

const PREFIX = "rxp-";
afterAll(() => dropFests(db, PREFIX));

let festId: string, techId: string, logiId: string, financeDeptId: string, coreId: string;
let expenseTypeId: string, techItem: string, logiItem: string;
let techMember: Actor, techHod: Actor, logiHod: Actor, finance: Actor, mgmt: Actor;

async function one<T extends Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T> {
  return ((await db.execute(q)) as unknown as T[])[0];
}

async function receipt(actor: Actor): Promise<string> {
  return (await one<{ id: string }>(sql`
    insert into attachments (fest_id, purpose, kind, storage_key, file_name, mime_type, size_bytes, uploaded_by)
    values (${festId}, 'RECEIPT', 'FILE', ${"k/" + Math.random()}, 'r.jpg', 'image/jpeg', 1024, ${actor.id})
    returning id`)).id;
}

const claim = async (actor: Actor, lineItemId: string, description: string, payee: string) =>
  createReimbursement(actor, {
    lineItemId, expenseTypeId, description,
    amountPaise: R(1200), transactionOn: "2026-11-20",
    payeeName: payee, payeeUpiId: `${payee.toLowerCase()}@upi`,
    attachmentIds: [await receipt(actor)], submit: true,
  });

/** Just the reference column, which is all these assertions are about. */
async function references(actor: Actor): Promise<string[]> {
  const out = await runExport(actor, "reimbursements", "csv");
  const lines = String(out.body).trim().split("\r\n");
  return lines.slice(1).map((l) => l.split(",")[0]);
}

beforeEach(async () => {
  festId = (await one<{ id: string }>(sql`
    insert into fests (name, slug, starts_on, ends_on, receipt_window_start, receipt_window_end, total_budget_paise)
    values ('Export Fest', ${PREFIX} || gen_random_uuid(), '2026-11-27','2026-11-29','2026-09-28','2026-12-14', ${R(1000000)})
    returning id`)).id;

  const mkDept = async (name: string, slug: string, kind: string, alloc = 0) =>
    (await one<{ id: string }>(sql`
      insert into departments (fest_id, name, slug, kind, allocated_paise)
      values (${festId}, ${name}, ${slug}, ${sql.raw(`'${kind}'::department_kind`)}, ${alloc}) returning id`)).id;

  financeDeptId = await mkDept("Finance", "finance", "FINANCE");
  coreId = await mkDept("Core", "core", "CORE");
  techId = await mkDept("Tech", "tech", "BUDGET", R(100000));
  logiId = await mkDept("Logistics", "logistics", "BUDGET", R(100000));

  const mkUser = async (email: string, role: Actor["role"], deptId: string): Promise<Actor> => ({
    id: (await one<{ id: string }>(sql`
      insert into users (fest_id, email, name, role, department_id, status)
      values (${festId}, ${email}, ${email}, ${sql.raw(`'${role}'::user_role`)}, ${deptId}, 'ACTIVE') returning id`)).id,
    festId, role, departmentId: deptId,
  });

  techMember = await mkUser("tm@x.test", "MEMBER", techId);
  techHod = await mkUser("th@x.test", "DEPT_HOD", techId);
  logiHod = await mkUser("lh@x.test", "DEPT_HOD", logiId);
  finance = await mkUser("fin@x.test", "FINANCE_HOD", financeDeptId);
  mgmt = await mkUser("mg@x.test", "MANAGEMENT", coreId);

  expenseTypeId = (await one<{ id: string }>(sql`
    insert into expense_types (fest_id, name) values (${festId}, 'Equipment') returning id`)).id;

  const mkItem = async (deptId: string, name: string) =>
    (await one<{ id: string }>(sql`
      insert into line_items (fest_id, department_id, name, planned_paise, created_by)
      values (${festId}, ${deptId}, ${name}, ${R(50000)}, ${finance.id}) returning id`)).id;
  techItem = await mkItem(techId, "Sound");
  logiItem = await mkItem(logiId, "Chairs");
});

/* ------------------------------------------------------------------ the scope */

test("Finance takes the whole fest", async () => {
  const a = await claim(techMember, techItem, "Cables for the main stage", "Ravi");
  const b = await claim(logiHod, logiItem, "Rope and stakes for the barricades", "Meera");

  expect((await references(finance)).sort()).toEqual([a.humanId, b.humanId].sort());
  // Management sees the same ledger — they are the ones paying out of it.
  expect((await references(mgmt)).sort()).toEqual([a.humanId, b.humanId].sort());
});

test("a head takes their own department and no more", async () => {
  const mine = await claim(techMember, techItem, "Cables for the main stage", "Ravi");
  await claim(logiHod, logiItem, "Rope and stakes for the barricades", "Meera");

  expect(await references(techHod)).toEqual([mine.humanId]);
});

/**
 * The one that matters most. A Member may file a claim and read their own; the file
 * must not hand them the rest of their department's — including, in the columns
 * above, every payee's UPI id.
 */
test("a Member takes their own claims and nobody else's", async () => {
  const mine = await claim(techMember, techItem, "Cables for the main stage", "Ravi");
  const theirs = await claim(techHod, techItem, "Gaffer tape, four rolls", "Priya");

  const got = await references(techMember);
  expect(got).toEqual([mine.humanId]);
  expect(got).not.toContain(theirs.humanId);
});

test("a payee's UPI id never appears in somebody else's file", async () => {
  await claim(techHod, techItem, "Gaffer tape, four rolls", "Priya");
  await claim(techMember, techItem, "Cables for the main stage", "Ravi");

  const out = await runExport(techMember, "reimbursements", "csv");
  expect(String(out.body)).toContain("ravi@upi");
  expect(String(out.body)).not.toContain("priya@upi");
});

/* ------------------------------------------------------------- what is in it */

test("the file carries the trail, not just the amount", async () => {
  const req = await claim(techMember, techItem, "Cables for the main stage", "Ravi");
  await transitionReimbursement(techHod, req.id, "ENDORSE");
  await transitionReimbursement(finance, req.id, "APPROVE");
  await transitionReimbursement(mgmt, req.id, "RECORD_PAYMENT", {
    payment_reference: "UTR-77", paid_at: "2026-11-25",
  });

  const body = String((await runExport(finance, "reimbursements", "csv")).body);
  const header = body.split("\r\n")[0];
  for (const column of ["Reference", "Status", "Waiting on", "Payee UPI", "Endorsed by", "Paid by", "Payment reference", "Receipts"]) {
    expect(header, column).toContain(column);
  }
  expect(body).toContain("UTR-77");
  expect(body).toContain("th@x.test");   // who endorsed it
  expect(body).toContain("PAID");
});

test("waiting-on is derived the same way the screen derives it", async () => {
  const req = await claim(techMember, techItem, "Cables for the main stage", "Ravi");
  const row = () => runExport(finance, "reimbursements", "csv").then((o) => String(o.body).split("\r\n")[1]);

  expect(await row()).toContain("Department HOD");
  await transitionReimbursement(techHod, req.id, "ENDORSE");
  expect(await row()).toContain("Finance HOD");
  await transitionReimbursement(finance, req.id, "APPROVE");
  expect(await row()).toContain("Management");
});

test("Excel is a real workbook, not a CSV with a different name", async () => {
  await claim(techMember, techItem, "Cables for the main stage", "Ravi");
  const out = await runExport(finance, "reimbursements", "xlsx");

  expect(out.filename).toMatch(/^yugaantar-reimbursements-.*\.xlsx$/);
  expect(out.contentType).toContain("spreadsheetml");
  // xlsx is a zip; "PK" is the local file header every one of them starts with.
  expect(Buffer.from(out.body as Buffer).subarray(0, 2).toString()).toBe("PK");
});

test("a filter narrows the file, and cannot widen it", async () => {
  const mine = await claim(techMember, techItem, "Cables for the main stage", "Ravi");
  await claim(logiHod, logiItem, "Rope and stakes for the barricades", "Meera");

  // Tech's head asking for Logistics gets their own department regardless — the
  // scope is forced from the actor, never read off the request.
  const out = await runExport(techHod, "reimbursements", "csv", { departmentId: logiId });
  const refs = String(out.body).trim().split("\r\n").slice(1).map((l) => l.split(",")[0]);
  expect(refs).toEqual([mine.humanId]);
});

test("an empty ledger still has its headers", async () => {
  // Not a blank file: somebody who opens this and sees the columns knows they have
  // nothing, where a zero-byte file only tells them something went wrong.
  const body = String((await runExport(techMember, "reimbursements", "csv")).body);
  const lines = body.trim().split("\r\n");
  expect(lines[0]).toContain("Reference");
  expect(lines).toHaveLength(1);
});

/* ---------------------------------------------------------------- the bills */

const LINK = /https?:\/\/[^,\r\n]+\/api\/v1\/bills\/([0-9a-f-]{36})\?sig=([0-9a-f]{64})/g;
const linksIn = (text: string) => [...text.matchAll(LINK)].map((m) => m[1]);

test("every bill on a claim gets its own link, in the order they were added", async () => {
  const first = await receipt(techMember);
  const second = await receipt(techMember);
  await createReimbursement(techMember, {
    lineItemId: techItem, expenseTypeId, description: "Cables for the main stage",
    amountPaise: R(1200), transactionOn: "2026-11-20",
    payeeName: "Ravi", payeeUpiId: "ravi@upi",
    attachmentIds: [first, second], submit: true,
  });
  await db.execute(sql`update attachments set created_at = now() - interval '1 hour' where id = ${first}`);
  await claim(techHod, techItem, "Gaffer tape, four rolls", "Priya");

  const body = String((await runExport(finance, "reimbursements", "csv")).body);
  expect(body.split("\r\n")[0]).toContain("Bill 1,Bill 2");
  expect(linksIn(body)).toContain(first);
  expect(linksIn(body)).toContain(second);
  expect(linksIn(body).indexOf(first)).toBeLessThan(linksIn(body).indexOf(second));
});

test("a removed bill is not linked", async () => {
  await claim(techMember, techItem, "Cables for the main stage", "Ravi");
  await db.execute(sql`update attachments set removed_at = now() where fest_id = ${festId}`);

  const body = String((await runExport(finance, "reimbursements", "csv")).body);
  expect(linksIn(body)).toEqual([]);
  // The column stays, so every export of this ledger has the same shape.
  expect(body.split("\r\n")[0]).toContain("Bill 1");
});

/**
 * The link is public on purpose, which makes scope the whole safeguard: holding the
 * file is holding the bills, so a file may only carry bills its reader may take.
 */
test("a Member's file links their own bills and nobody else's", async () => {
  await claim(techMember, techItem, "Cables for the main stage", "Ravi");
  await claim(techHod, techItem, "Gaffer tape, four rolls", "Priya");

  const all = linksIn(String((await runExport(finance, "reimbursements", "csv")).body));
  const own = linksIn(String((await runExport(techMember, "reimbursements", "csv")).body));
  expect(all).toHaveLength(2);
  expect(own).toHaveLength(1);
  expect(all).toContain(own[0]);
});

test("a link in the file opens the bill with nobody signed in, and does not expire", async () => {
  await claim(techMember, techItem, "Cables for the main stage", "Ravi");

  const body = String((await runExport(finance, "reimbursements", "csv")).body);
  expect(body).not.toMatch(/X-Amz|[?&]expires=/);

  const [match] = [...body.matchAll(LINK)];
  await expect(publicBillUrl(match[1], match[2])).resolves.toContain("sig=");
});

test("the workbook's bill cells are hyperlinks", async () => {
  await claim(techMember, techItem, "Cables for the main stage", "Ravi");
  const { body } = await runExport(finance, "reimbursements", "xlsx");

  // Stored deflated, so look for the part's name rather than its contents; the
  // contents are `tests/unit/xlsx.test.ts`'s job.
  expect(Buffer.from(body as Buffer).includes("xl/worksheets/_rels/sheet1.xml.rels")).toBe(true);
});
