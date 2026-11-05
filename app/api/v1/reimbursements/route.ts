import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { departments, expenseTypes, flags, lineItems, reimbursementRequests, users } from "@/db/schema";
import { canFestWide } from "@/lib/authz";
import { page, parseBody, parseQuery, route } from "@/lib/api";
import { createReimbursement } from "@/lib/services/reimbursements";
import { REIMBURSEMENT_STATES } from "@/lib/state-machines/reimbursement";

const listQuery = z.object({
  status: z.string().optional(),
  department_id: z.uuid().optional(),
  line_item_id: z.uuid().optional(),
  submitter_id: z.uuid().optional(),
  flagged: z.enum(["0", "1"]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** PRD 20.6 — Member sees own; Dept HOD their department; Finance and Management everything. */
export const GET = route(async ({ user, request }) => {
  const f = parseQuery(request, listQuery);

  // No department in scope: only the roles with fest-wide reach come back true.
  const seesAll = canFestWide(user, "reimbursement.view");
  const scope = seesAll
    ? undefined
    : user.role === "DEPT_HOD"
      ? eq(reimbursementRequests.departmentId, user.departmentId)
      : eq(reimbursementRequests.submitterId, user.id);

  const flagged = f.flagged === "1"
    ? inArray(reimbursementRequests.id, db.select({ id: flags.entityId }).from(flags)
        .where(and(eq(flags.entityType, "REIMBURSEMENT"), eq(flags.status, "OPEN"))))
    : undefined;

  const statuses = f.status?.split(",").filter((s) => (REIMBURSEMENT_STATES as readonly string[]).includes(s));

  const rows = await db
    .select({
      id: reimbursementRequests.id,
      human_id: reimbursementRequests.humanId,
      status: reimbursementRequests.status,
      amount_paise: reimbursementRequests.amountPaise,
      description: reimbursementRequests.description,
      transaction_on: reimbursementRequests.transactionOn,
      payee_name: reimbursementRequests.payeeName,
      submitted_at: reimbursementRequests.submittedAt,
      created_at: reimbursementRequests.createdAt,
      submitter: users.name,
      department: departments.name,
      line_item: lineItems.name,
      expense_type: expenseTypes.name,
      flag_count: sql<number>`(
        select count(*) from flags
        where flags.entity_type = 'REIMBURSEMENT' and flags.entity_id = ${reimbursementRequests.id}
          and flags.status = 'OPEN')`.mapWith(Number),
    })
    .from(reimbursementRequests)
    .innerJoin(users, eq(users.id, reimbursementRequests.submitterId))
    .innerJoin(departments, eq(departments.id, reimbursementRequests.departmentId))
    .innerJoin(lineItems, eq(lineItems.id, reimbursementRequests.lineItemId))
    .innerJoin(expenseTypes, eq(expenseTypes.id, reimbursementRequests.expenseTypeId))
    .where(and(
      eq(reimbursementRequests.festId, user.festId),
      isNull(reimbursementRequests.deletedAt),
      scope,
      flagged,
      statuses?.length ? inArray(reimbursementRequests.status, statuses as never[]) : undefined,
      f.department_id ? eq(reimbursementRequests.departmentId, f.department_id) : undefined,
      f.line_item_id ? eq(reimbursementRequests.lineItemId, f.line_item_id) : undefined,
      f.submitter_id ? eq(reimbursementRequests.submitterId, f.submitter_id) : undefined,
      f.from ? gte(reimbursementRequests.transactionOn, f.from) : undefined,
      f.to ? lte(reimbursementRequests.transactionOn, f.to) : undefined,
      f.q ? or(
        sql`${reimbursementRequests.description} ilike ${"%" + f.q + "%"}`,
        sql`${reimbursementRequests.humanId} ilike ${"%" + f.q + "%"}`,
        sql`${reimbursementRequests.merchant} ilike ${"%" + f.q + "%"}`,
      ) : undefined,
    ))
    .orderBy(desc(reimbursementRequests.createdAt))
    .limit(f.limit + 1);

  return page(rows, f.limit, (r) => r.id);
});

const createSchema = z.object({
  line_item_id: z.uuid(),
  expense_type_id: z.uuid(),
  description: z.string().min(10, "Say what it was for — at least 10 characters").max(1000),
  transaction_on: z.iso.date(),
  amount_paise: z.number().int().positive(),
  merchant: z.string().max(120).nullish(),
  payee_name: z.string().min(2).max(120),
  payee_upi_id: z.string().regex(/^[\w.\-]{2,}@[a-zA-Z]{2,}$/, "Not a valid UPI ID"),
  attachment_ids: z.array(z.uuid()).min(1, "At least one receipt is required").max(5),
  payment_proof_ids: z.array(z.uuid())
    .min(1, "Proof of payment is required — a UPI screenshot, card slip or bank statement").max(3),
  submit: z.boolean().default(false),
});

export const POST = route(async ({ user, request }) => {
  const b = await parseBody(request, createSchema);
  return createReimbursement(user, {
    lineItemId: b.line_item_id,
    expenseTypeId: b.expense_type_id,
    description: b.description,
    transactionOn: b.transaction_on,
    amountPaise: b.amount_paise,
    merchant: b.merchant,
    payeeName: b.payee_name,
    payeeUpiId: b.payee_upi_id,
    attachmentIds: b.attachment_ids,
    paymentProofIds: b.payment_proof_ids,
    submit: b.submit,
  });
}, { idempotent: true });
