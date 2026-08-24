/**
 * `pnpm db:seed` — bootstraps a real, empty fest.
 *
 * This is not demo data. It creates exactly what the schema and the PRD require
 * before anyone can do anything, and nothing else:
 *
 *   - the fest, with the section 19.5 settings;
 *   - the Finance and Core departments, which the schema requires exactly one of
 *     each and which therefore cannot be created from the admin screen;
 *   - the expense types from PRD 21.1 (reference data, not sample data);
 *   - one Finance HOD, who is the platform administrator (open question 14, draft).
 *
 * Everything else — budget departments, their allocations, line items, vendors,
 * people — the administrator creates through the app, because that is the workflow
 * the fest actually has to run.
 *
 * Idempotent: running it again leaves existing records alone and fills in what is
 * missing. Pass `--reset` to tear the fest down first — that deletes real records,
 * so it refuses to run in production.
 */
import "dotenv/config";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";
import { rupeesToPaise } from "../lib/money.js";
import { dropFestBySlug } from "../lib/test-support.js";

const { fests, departments, users, expenseTypes } = schema;

const client = postgres(process.env.DATABASE_URL!, { max: 1 });
const db = drizzle(client, { schema, casing: "snake_case" });

const DOMAIN = process.env.ALLOWED_EMAIL_DOMAIN || "sst.scaler.com";
const R = rupeesToPaise;

/**
 * The first administrator. Overridable so another deployment needs no code change,
 * but it has to be somebody: a fest with no Finance HOD has nobody who can invite one.
 */
const ADMIN_EMAIL = (process.env.BOOTSTRAP_ADMIN_EMAIL || `ajij.24bcs10103@${DOMAIN}`).toLowerCase();
const ADMIN_NAME = process.env.BOOTSTRAP_ADMIN_NAME || "Ajij Uttam";

const FEST_SLUG = process.env.BOOTSTRAP_FEST_SLUG || "yugaantar-26";
const FEST_NAME = process.env.BOOTSTRAP_FEST_NAME || "Yugaantar '26";

const reset = process.argv.includes("--reset");

/* -------------------------------------------------------------------- reset */

const [existing] = await db.select({ id: fests.id }).from(fests).where(eq(fests.slug, FEST_SLUG));

if (existing && reset) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("--reset deletes real records and will not run in production");
  }
  console.log(`seed: --reset given, tearing down ${FEST_SLUG}`);
  // One teardown, shared with the database tests (`lib/test-support.ts`). The
  // foreign-key order is subtle enough that a second copy would drift and only
  // fail once there was data of the right shape to notice.
  await dropFestBySlug(db, FEST_SLUG);
}

/* --------------------------------------------------------------------- fest */

const [inserted] = await db
  .insert(fests)
  .values({
    name: FEST_NAME,
    slug: FEST_SLUG,
    startsOn: "2026-11-27",
    endsOn: "2026-11-29",
    // Default receipt window: start − 60 days to end + 15 days (PRD 6.1).
    receiptWindowStart: "2026-09-28",
    receiptWindowEnd: "2026-12-14",
    // Finance sets the real figure from the budget screen. Starting at zero means
    // the first allocation is a deliberate act rather than an inherited number.
    totalBudgetPaise: 0,
    settings: {
      fest_days: ["2026-11-27", "2026-11-28", "2026-11-29"],
      line_item_doc_threshold_paise: R(10000),
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
  })
  .onConflictDoNothing()
  .returning();

const [fest] = inserted
  ? [inserted]
  : await db.select().from(fests).where(eq(fests.slug, FEST_SLUG));

/* -------------------------------------------------------------- departments */

/**
 * Finance and Core only. The schema permits exactly one of each per fest
 * (`departments_one_finance` / `departments_one_core`), so they cannot come from the
 * admin screen — which creates BUDGET departments — and they have to exist before
 * anyone can be given a role.
 */
await db
  .insert(departments)
  .values([
    { festId: fest.id, name: "Finance", slug: "finance", kind: "FINANCE" as const, allocatedPaise: 0 },
    { festId: fest.id, name: "Core", slug: "core", kind: "CORE" as const, allocatedPaise: 0 },
  ])
  .onConflictDoNothing();

const deptRows = await db.select().from(departments).where(eq(departments.festId, fest.id));
const financeDept = deptRows.find((d) => d.kind === "FINANCE")!;

/* ------------------------------------------------------------ expense types */

// PRD 21.1's list: reference data every fest needs. Finance edits it from /admin.
await db
  .insert(expenseTypes)
  .values(
    ["Equipment Rental", "Printing & Signage", "Food & Refreshments", "Travel & Transport",
     "Decor & Props", "Prizes & Gifts", "Marketing & Promotion", "Accommodation", "Miscellaneous"]
      .map((name, sortOrder) => ({ festId: fest.id, name, sortOrder })),
  )
  .onConflictDoNothing();

/* -------------------------------------------- the first administrator (5.1) */

const [created] = await db
  .insert(users)
  .values({
    festId: fest.id,
    name: ADMIN_NAME,
    email: ADMIN_EMAIL,
    // Open question 14, draft: the Finance HOD is the platform administrator.
    role: "FINANCE_HOD",
    departmentId: financeDept.id,
    // ACTIVE rather than INVITED: there is nobody else who could accept for them.
    status: "ACTIVE",
    digestOptIn: true,
  })
  .onConflictDoNothing()
  .returning();

const [administrator] = created
  ? [created]
  : await db.select().from(users).where(eq(users.email, ADMIN_EMAIL));

/* ------------------------------------------------------------------- report */

const [counts] = (await db.execute(sql`
  select
    (select count(*)::int from departments   where fest_id = ${fest.id}) as departments,
    (select count(*)::int from users         where fest_id = ${fest.id}) as users,
    (select count(*)::int from expense_types where fest_id = ${fest.id}) as expense_types,
    (select count(*)::int from line_items    where fest_id = ${fest.id}) as line_items
`)) as unknown as Record<string, number>[];

console.log(`\nbootstrapped ${fest.name}`);
console.log(`  departments    ${counts.departments}  (Finance, Core — add the rest from /admin)`);
console.log(`  expense types  ${counts.expense_types}`);
console.log(`  users          ${counts.users}`);
console.log(`  line items     ${counts.line_items}`);
console.log(`  total budget   ${fest.totalBudgetPaise / 100}  (set it from /admin)`);
console.log(`\n  administrator  ${administrator.name} <${administrator.email}> — finance hod\n`);
console.log(`Next: open /sign-in, enter that address, and follow the emailed link.`);
console.log(`Then set the total budget and add departments from /admin.\n`);

await client.end();
