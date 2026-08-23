/**
 * `pnpm db:seed` — a usable demo (PRD 21.3): one fest, the Finance and Core departments
 * plus five budget departments, one user per role, expense types, and line items with
 * supporting documents on both sides of the ₹10,000 document threshold.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";
import { rupeesToPaise } from "../lib/money.js";
import { withAuditGuardLifted } from "../lib/test-support.js";
import { evaluateLineItemFlags } from "../lib/flags/index.js";

const {
  fests, departments, users, expenseTypes, lineItems, attachments, vendors,
} = schema;

const client = postgres(process.env.DATABASE_URL!, { max: 1 });
const db = drizzle(client, { schema, casing: "snake_case" });

const DOMAIN = process.env.ALLOWED_EMAIL_DOMAIN || "sst.scaler.com";
const R = rupeesToPaise;

const existing = await db.select({ id: fests.id }).from(fests).where(sql`slug = 'yugaantar-26'`);
if (existing.length > 0) {
  console.log("seed: yugaantar-26 already exists — dropping and reseeding");
  const id = existing[0].id;
  // `audit_events` is append-only in normal operation; a reseed is the documented
  // exception and says so out loud rather than quietly deleting.
  await withAuditGuardLifted(db, async (tx) => {
  for (const stmt of [
    sql`delete from income_tranches where income_entry_id in (select id from income_entries where fest_id = ${id})`,
    sql`delete from income_entries where fest_id = ${id}`,
    sql`delete from vendor_milestones where vendor_request_id in (select id from vendor_requests where fest_id = ${id})`,
    sql`delete from vendor_requests where fest_id = ${id}`,
    sql`delete from reimbursement_requests where fest_id = ${id}`,
    sql`delete from comment_mentions where comment_id in (select id from comments where fest_id = ${id})`,
    sql`delete from comments where fest_id = ${id}`,
    sql`delete from ticket_watchers where ticket_id in (select id from tickets where fest_id = ${id})`,
    sql`delete from tickets where fest_id = ${id}`,
    sql`delete from entity_links where fest_id = ${id}`,
    sql`delete from notifications where fest_id = ${id}`,
    sql`delete from flags where fest_id = ${id}`,
    sql`delete from audit_events where fest_id = ${id}`,
    sql`delete from attachments where fest_id = ${id}`,
    sql`delete from vendors where fest_id = ${id}`,
    sql`delete from line_items where fest_id = ${id}`,
    sql`delete from expense_types where fest_id = ${id}`,
    sql`delete from idempotency_keys where user_id in (select id from users where fest_id = ${id})`,
    sql`delete from users where fest_id = ${id}`,
    sql`delete from human_id_sequences where fest_id = ${id}`,
    sql`delete from budget_transfers where fest_id = ${id}`,
    sql`delete from ticket_templates where fest_id = ${id}`,
    sql`delete from departments where fest_id = ${id}`,
    sql`delete from fests where id = ${id}`,
  ]) await tx.execute(stmt);
  });
}

const [fest] = await db.insert(fests).values({
  name: "Yugaantar '26",
  slug: "yugaantar-26",
  startsOn: "2026-11-27",
  endsOn: "2026-11-29",
  // Default receipt window: start − 60 days to end + 15 days (PRD 6.1).
  receiptWindowStart: "2026-09-28",
  receiptWindowEnd: "2026-12-14",
  totalBudgetPaise: R(2500000),
  settings: {
    fest_days: ["2026-11-27", "2026-11-28", "2026-11-29"],
    line_item_doc_threshold_paise: 1000000,
    request_aging_amber_days: 3,
    request_aging_red_days: 7,
    ticket_auto_close_hours: 48,
    ticket_done_reminder_hours: 24,
    ticket_sla_minutes: {
      URGENT: { fest: 30, other: 120 },
      HIGH: { fest: 120, other: 480 },
      MEDIUM: { fest: 1440, other: 1440 },
      LOW: { fest: 4320, other: 4320 },
    },
    flag_thresholds: {
      F2_abs_paise: 5000, F2_pct: 5,
      F4_before_days: 60, F4_after_days: 15,
      F6_count: 5, F6_total_paise: 2500000,
      F8_pct: 50, F10_threshold_paise: 1000000,
      F11_multiplier: 3, F11_min_samples: 10,
      F14_pct: 20,
      income_followup_days: 30,
    },
  },
}).returning();

const deptRows = await db.insert(departments).values([
  { festId: fest.id, name: "Finance", slug: "finance", kind: "FINANCE", allocatedPaise: 0 },
  { festId: fest.id, name: "Core", slug: "core", kind: "CORE", allocatedPaise: 0 },
  { festId: fest.id, name: "Tech", slug: "tech", allocatedPaise: R(600000) },
  { festId: fest.id, name: "Logistics", slug: "logistics", allocatedPaise: R(500000) },
  { festId: fest.id, name: "Hospitality", slug: "hospitality", allocatedPaise: R(300000) },
  { festId: fest.id, name: "Cultural", slug: "cultural", allocatedPaise: R(400000) },
  { festId: fest.id, name: "Sponsorship", slug: "sponsorship", allocatedPaise: R(100000) },
]).returning();
const dept = Object.fromEntries(deptRows.map((d) => [d.slug, d]));
// Σ allocations ₹19,00,000 of a ₹25,00,000 total — ₹6,00,000 stays in Reserve (6.3).

const userRows = await db.insert(users).values([
  { festId: fest.id, email: `finance.hod@${DOMAIN}`, name: "Finance HOD", role: "FINANCE_HOD", departmentId: dept.finance.id, status: "ACTIVE", upiId: `finance@upi` },
  { festId: fest.id, email: `management@${DOMAIN}`, name: "Management", role: "MANAGEMENT", departmentId: dept.core.id, status: "ACTIVE" },
  { festId: fest.id, email: `tech.hod@${DOMAIN}`, name: "Tech HOD", role: "DEPT_HOD", departmentId: dept.tech.id, status: "ACTIVE", upiId: `tech.hod@upi` },
  { festId: fest.id, email: `logistics.hod@${DOMAIN}`, name: "Logistics HOD", role: "DEPT_HOD", departmentId: dept.logistics.id, status: "ACTIVE", upiId: `logi.hod@upi` },
  { festId: fest.id, email: `sponsorship.hod@${DOMAIN}`, name: "Sponsorship HOD", role: "DEPT_HOD", departmentId: dept.sponsorship.id, status: "ACTIVE" },
  { festId: fest.id, email: `tech.member@${DOMAIN}`, name: "Tech Member", role: "MEMBER", departmentId: dept.tech.id, status: "ACTIVE", upiId: `tech.member@upi` },
  { festId: fest.id, email: `logistics.member@${DOMAIN}`, name: "Logistics Member", role: "MEMBER", departmentId: dept.logistics.id, status: "ACTIVE", upiId: `logi.member@upi` },
]).returning();
const user = Object.fromEntries(userRows.map((u) => [u.email.split("@")[0], u]));

const typeRows = await db.insert(expenseTypes).values(
  ["Food & Beverages", "Travel & Transport", "Printing & Stationery", "Equipment Rental",
   "Decor & Props", "Prizes & Gifts", "Marketing & Promotion", "Accommodation", "Miscellaneous"]
    .map((name, sortOrder) => ({ festId: fest.id, name, sortOrder })),
).returning();
const type = Object.fromEntries(typeRows.map((t) => [t.name, t]));

const items = await db.insert(lineItems).values([
  { festId: fest.id, departmentId: dept.tech.id, name: "Sound system", plannedPaise: R(200000), defaultExpenseTypeId: type["Equipment Rental"].id, createdBy: user["tech.hod"].id, description: "Main stage PA, three days" },
  { festId: fest.id, departmentId: dept.tech.id, name: "Stage lighting", plannedPaise: R(180000), defaultExpenseTypeId: type["Equipment Rental"].id, createdBy: user["tech.hod"].id },
  { festId: fest.id, departmentId: dept.tech.id, name: "Cables & consumables", plannedPaise: R(8000), defaultExpenseTypeId: type["Miscellaneous"].id, createdBy: user["tech.hod"].id },
  { festId: fest.id, departmentId: dept.logistics.id, name: "Chairs & tables rental", plannedPaise: R(150000), defaultExpenseTypeId: type["Equipment Rental"].id, createdBy: user["logistics.hod"].id },
  { festId: fest.id, departmentId: dept.logistics.id, name: "Transport", plannedPaise: R(90000), defaultExpenseTypeId: type["Travel & Transport"].id, createdBy: user["logistics.hod"].id },
  { festId: fest.id, departmentId: dept.hospitality.id, name: "Artist accommodation", plannedPaise: R(200000), defaultExpenseTypeId: type["Accommodation"].id, createdBy: user["finance.hod"].id },
  { festId: fest.id, departmentId: dept.cultural.id, name: "Headline artist fee", plannedPaise: R(300000), defaultExpenseTypeId: type["Miscellaneous"].id, createdBy: user["finance.hod"].id },
]).returning();
const item = Object.fromEntries(items.map((i) => [i.name, i]));

// Three quotes on one line item is the normal case (7.1). Links need no upload.
await db.insert(attachments).values([
  { festId: fest.id, entityType: "LINE_ITEM", entityId: item["Sound system"].id, purpose: "QUOTE", kind: "LINK", url: "https://www.indiamart.com/example-sound-rental", label: "Quotation — ABC Sound", sourceName: "ABC Sound Systems", quotedAmountPaise: R(195000), uploadedBy: user["tech.hod"].id },
  { festId: fest.id, entityType: "LINE_ITEM", entityId: item["Sound system"].id, purpose: "QUOTE", kind: "LINK", url: "https://www.indiamart.com/example-sound-rental-2", label: "Quotation — Bengaluru Audio", sourceName: "Bengaluru Audio", quotedAmountPaise: R(210000), uploadedBy: user["tech.hod"].id },
  { festId: fest.id, entityType: "LINE_ITEM", entityId: item["Sound system"].id, purpose: "LISTING", kind: "LINK", url: "https://www.amazon.in/example-listing", label: "Amazon listing — reference", sourceName: "Amazon", quotedAmountPaise: R(205000), uploadedBy: user["tech.hod"].id },
  // Stage lighting is above the threshold with no document — seeds flag F13.
  { festId: fest.id, entityType: "LINE_ITEM", entityId: item["Transport"].id, purpose: "QUOTE", kind: "LINK", url: "https://example.com/tempo-traveller-quote", label: "Quotation — Sri Travels", sourceName: "Sri Travels", quotedAmountPaise: R(70000), uploadedBy: user["logistics.hod"].id },
]);

await db.insert(vendors).values([
  { festId: fest.id, name: "ABC Sound Systems", contactName: "Ravi", phone: "+91 90000 00001", upiId: "abcsound@upi", createdBy: user["tech.hod"].id },
  { festId: fest.id, name: "Sri Travels", contactName: "Kumar", phone: "+91 90000 00002", bankAccountName: "Sri Travels", bankAccountNumber: "123456789012", bankIfsc: "HDFC0001234", createdBy: user["logistics.hod"].id },
]);

/**
 * Flags are evaluated on write (8.3), and nothing here goes through a service, so
 * the demo would open with an empty flags panel. Running the rules once at the end
 * makes the seeded state honest: Stage lighting and the other undocumented items
 * above the threshold raise F13, and Sound system raises F14 for being planned
 * above its own lowest quote.
 */
await db.transaction(async (tx) => {
  for (const li of items) await evaluateLineItemFlags(tx as never, li.id);
});

const [totals] = await db.execute<Record<string, string>>(
  sql`select * from v_fest_totals where fest_id = ${fest.id}`,
) as unknown as Record<string, string>[];

const [flagged] = await db.execute<Record<string, string>>(
  sql`select count(*) as n from flags where fest_id = ${fest.id} and status = 'OPEN'`,
) as unknown as Record<string, string>[];

console.log(`seeded ${fest.name}`);
console.log(`  departments   ${deptRows.length}   users ${userRows.length}   line items ${items.length}`);
console.log(`  total budget  ${Number(totals.total_budget_paise) / 100}`);
console.log(`  reserve       ${Number(totals.reserve_paise) / 100}`);
console.log(`  open flags    ${flagged.n}`);
console.log(`  sign in as    finance.hod@${DOMAIN}`);
await client.end();
