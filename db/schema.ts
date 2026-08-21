/**
 * Drizzle schema — mirrors PRD section 19.2 one-for-one.
 * All amounts are bigint paise. All timestamps are timestamptz.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** Postgres citext — case-insensitive text, used for emails. */
const citext = customType<{ data: string }>({ dataType: () => "citext" });

const paise = (name: string) => bigint(name, { mode: "number" });
const ts = (name: string) => timestamp(name, { withTimezone: true });

/* ------------------------------------------------------------------ 19.1 enums */

export const userRole = pgEnum("user_role", ["MEMBER", "DEPT_HOD", "FINANCE_HOD", "MANAGEMENT"]);
export const userStatus = pgEnum("user_status", ["INVITED", "ACTIVE", "DISABLED"]);
export const departmentKind = pgEnum("department_kind", ["BUDGET", "FINANCE", "CORE"]);
export const lineItemStatus = pgEnum("line_item_status", ["OPEN", "CLOSED"]);
export const reimbursementStatus = pgEnum("reimbursement_status", [
  "DRAFT", "SUBMITTED", "SENT_BACK", "HOD_ENDORSED", "APPROVED", "ON_HOLD", "PAID", "DECLINED", "WITHDRAWN",
]);
export const vendorRequestStatus = pgEnum("vendor_request_status", [
  "DRAFT", "SUBMITTED", "SENT_BACK", "APPROVED", "ADVANCE_PAID", "DELIVERED", "BALANCE_APPROVED", "CLOSED", "DECLINED", "CANCELLED",
]);
export const milestoneKind = pgEnum("milestone_kind", ["ADVANCE", "BALANCE", "OTHER"]);
export const incomeType = pgEnum("income_type", [
  "SPONSORSHIP_CASH", "SPONSORSHIP_IN_KIND", "EVENT_TICKETS", "COLLEGE_GRANT", "OTHER",
]);
export const incomeStatus = pgEnum("income_status", ["PLEDGED", "PARTIALLY_RECEIVED", "RECEIVED", "WRITTEN_OFF"]);
export const ticketStatus = pgEnum("ticket_status", [
  "OPEN", "NEEDS_INFO", "ACCEPTED", "IN_PROGRESS", "BLOCKED", "DONE", "CLOSED", "REJECTED", "CANCELLED",
]);
export const ticketPriority = pgEnum("ticket_priority", ["LOW", "MEDIUM", "HIGH", "URGENT"]);
export const flagSeverity = pgEnum("flag_severity", ["LOW", "MEDIUM", "HIGH"]);
export const flagStatus = pgEnum("flag_status", ["OPEN", "ACKNOWLEDGED", "DISMISSED"]);
export const entityType = pgEnum("entity_type", [
  "FEST", "DEPARTMENT", "LINE_ITEM", "REIMBURSEMENT", "VENDOR", "VENDOR_REQUEST", "VENDOR_MILESTONE",
  "INCOME_ENTRY", "BUDGET_TRANSFER", "TICKET", "USER", "ATTACHMENT", "COMMENT", "FLAG",
]);
export const attachmentPurpose = pgEnum("attachment_purpose", [
  "RECEIPT", "QUOTE", "LISTING", "PO", "INVOICE", "DELIVERY_PROOF", "PAYMENT_PROOF", "MOU",
  "TICKET_ATTACHMENT", "TICKET_PROOF", "OTHER",
]);
export const attachmentKind = pgEnum("attachment_kind", ["FILE", "LINK"]);
export const notificationChannel = pgEnum("notification_channel", ["IN_APP", "EMAIL", "PUSH", "WHATSAPP"]);

/* ------------------------------------------------------------------ 19.2 tables */

export const fests = pgTable("fests", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  startsOn: date("starts_on").notNull(),
  endsOn: date("ends_on").notNull(),
  receiptWindowStart: date("receipt_window_start").notNull(),
  receiptWindowEnd: date("receipt_window_end").notNull(),
  totalBudgetPaise: paise("total_budget_paise").notNull().default(0),
  currency: char("currency", { length: 3 }).notNull().default("INR"),
  settings: jsonb("settings").notNull().default({}),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [check("fests_budget_nonneg", sql`${t.totalBudgetPaise} >= 0`)]);

export const departments = pgTable("departments", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  festId: uuid("fest_id").notNull().references(() => fests.id),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  kind: departmentKind("kind").notNull().default("BUDGET"),
  allocatedPaise: paise("allocated_paise").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  unique("departments_fest_slug").on(t.festId, t.slug),
  check("departments_alloc_nonneg", sql`${t.allocatedPaise} >= 0`),
  uniqueIndex("departments_one_finance").on(t.festId).where(sql`kind = 'FINANCE'`),
  uniqueIndex("departments_one_core").on(t.festId).where(sql`kind = 'CORE'`),
]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  festId: uuid("fest_id").notNull().references(() => fests.id),
  clerkUserId: text("clerk_user_id").unique(),
  email: citext("email").notNull(),
  name: text("name").notNull(),
  role: userRole("role").notNull(),
  departmentId: uuid("department_id").notNull().references(() => departments.id),
  upiId: text("upi_id"),
  phone: text("phone"),
  status: userStatus("status").notNull().default("INVITED"),
  digestOptIn: boolean("digest_opt_in").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  unique("users_fest_email").on(t.festId, t.email),
  index("users_fest_role_dept_idx").on(t.festId, t.role, t.departmentId),
]);

export const expenseTypes = pgTable("expense_types", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  festId: uuid("fest_id").notNull().references(() => fests.id),
  name: text("name").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
}, (t) => [unique("expense_types_fest_name").on(t.festId, t.name)]);

export const lineItems = pgTable("line_items", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  festId: uuid("fest_id").notNull().references(() => fests.id),
  departmentId: uuid("department_id").notNull().references(() => departments.id),
  name: text("name").notNull(),
  description: text("description"),
  plannedPaise: paise("planned_paise").notNull(),
  defaultExpenseTypeId: uuid("default_expense_type_id").references(() => expenseTypes.id),
  status: lineItemStatus("status").notNull().default("OPEN"),
  closedAt: ts("closed_at"),
  closedBy: uuid("closed_by").references(() => users.id),
  closeReason: text("close_reason"),
  reviewedAt: ts("reviewed_at"),
  reviewedBy: uuid("reviewed_by").references(() => users.id),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  deletedAt: ts("deleted_at"),
}, (t) => [
  check("line_items_planned_nonneg", sql`${t.plannedPaise} >= 0`),
  index("line_items_dept_idx").on(t.departmentId).where(sql`deleted_at is null`),
]);

export const attachments = pgTable("attachments", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  festId: uuid("fest_id").notNull().references(() => fests.id),
  entityType: entityType("entity_type"),
  entityId: uuid("entity_id"),
  purpose: attachmentPurpose("purpose").notNull(),
  kind: attachmentKind("kind").notNull(),
  storageKey: text("storage_key"),
  url: text("url"),
  fileName: text("file_name"),
  mimeType: text("mime_type"),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  sha256: text("sha256"),
  phash: text("phash"),
  label: text("label"),
  sourceName: text("source_name"),
  quotedAmountPaise: paise("quoted_amount_paise"),
  ocrJson: jsonb("ocr_json"),
  uploadedBy: uuid("uploaded_by").notNull().references(() => users.id),
  createdAt: ts("created_at").notNull().defaultNow(),
  removedAt: ts("removed_at"),
  removedBy: uuid("removed_by").references(() => users.id),
}, (t) => [
  check("attachments_kind_shape", sql`(${t.kind} = 'FILE' and ${t.storageKey} is not null) or (${t.kind} = 'LINK' and ${t.url} is not null)`),
  index("attachments_entity_idx").on(t.entityType, t.entityId).where(sql`removed_at is null`),
  index("attachments_sha_idx").on(t.festId, t.sha256).where(sql`sha256 is not null`),
  index("attachments_phash_idx").on(t.festId, t.phash).where(sql`phash is not null`),
]);

export const reimbursementRequests = pgTable("reimbursement_requests", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  festId: uuid("fest_id").notNull().references(() => fests.id),
  humanId: text("human_id").notNull(),
  departmentId: uuid("department_id").notNull().references(() => departments.id),
  lineItemId: uuid("line_item_id").notNull().references(() => lineItems.id),
  expenseTypeId: uuid("expense_type_id").notNull().references(() => expenseTypes.id),
  submitterId: uuid("submitter_id").notNull().references(() => users.id),
  description: text("description").notNull(),
  transactionOn: date("transaction_on").notNull(),
  amountPaise: paise("amount_paise").notNull(),
  merchant: text("merchant"),
  payeeName: text("payee_name").notNull(),
  payeeUpiId: text("payee_upi_id").notNull(),
  status: reimbursementStatus("status").notNull().default("DRAFT"),
  version: integer("version").notNull().default(1),
  submittedAt: ts("submitted_at"),
  endorsedBy: uuid("endorsed_by").references(() => users.id),
  endorsedAt: ts("endorsed_at"),
  approvedBy: uuid("approved_by").references(() => users.id),
  approvedAt: ts("approved_at"),
  approvalNote: text("approval_note"),
  paidBy: uuid("paid_by").references(() => users.id),
  paidAt: ts("paid_at"),
  paymentReference: text("payment_reference"),
  lastReason: text("last_reason"),
  sendBackCount: integer("send_back_count").notNull().default(0),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  deletedAt: ts("deleted_at"),
}, (t) => [
  unique("reimbursements_fest_human_id").on(t.festId, t.humanId),
  check("reimbursements_description_len", sql`char_length(${t.description}) >= 10`),
  check("reimbursements_amount_positive", sql`${t.amountPaise} > 0`),
  index("reimbursements_fest_status_idx").on(t.festId, t.status),
  index("reimbursements_dept_status_idx").on(t.departmentId, t.status),
  index("reimbursements_line_item_idx").on(t.lineItemId),
  index("reimbursements_submitter_idx").on(t.submitterId),
  index("reimbursements_payee_idx").on(t.festId, t.payeeUpiId),
  index("reimbursements_dup_idx").on(t.festId, t.amountPaise, t.transactionOn, t.merchant),
]);

export const vendors = pgTable("vendors", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  festId: uuid("fest_id").notNull().references(() => fests.id),
  name: text("name").notNull(),
  contactName: text("contact_name"),
  phone: text("phone"),
  email: citext("email"),
  bankAccountName: text("bank_account_name"),
  bankAccountNumber: text("bank_account_number"),
  bankIfsc: text("bank_ifsc"),
  upiId: text("upi_id"),
  gstin: text("gstin"),
  notes: text("notes"),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  deletedAt: ts("deleted_at"),
}, (t) => [unique("vendors_fest_name").on(t.festId, t.name)]);

export const vendorRequests = pgTable("vendor_requests", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  festId: uuid("fest_id").notNull().references(() => fests.id),
  humanId: text("human_id").notNull(),
  departmentId: uuid("department_id").notNull().references(() => departments.id),
  lineItemId: uuid("line_item_id").notNull().references(() => lineItems.id),
  vendorId: uuid("vendor_id").notNull().references(() => vendors.id),
  description: text("description").notNull(),
  totalValuePaise: paise("total_value_paise").notNull(),
  approvedValuePaise: paise("approved_value_paise"),
  expectedDeliveryOn: date("expected_delivery_on"),
  status: vendorRequestStatus("status").notNull().default("DRAFT"),
  requestedBy: uuid("requested_by").notNull().references(() => users.id),
  approvedBy: uuid("approved_by").references(() => users.id),
  approvedAt: ts("approved_at"),
  deliveredAt: ts("delivered_at"),
  deliveryNote: text("delivery_note"),
  deliveryConfirmedBy: uuid("delivery_confirmed_by").references(() => users.id),
  balanceApprovedBy: uuid("balance_approved_by").references(() => users.id),
  balanceApprovedAt: ts("balance_approved_at"),
  balanceAdjustReason: text("balance_adjust_reason"),
  refundExpectedPaise: paise("refund_expected_paise").notNull().default(0),
  refundReceivedPaise: paise("refund_received_paise").notNull().default(0),
  refundReceivedAt: ts("refund_received_at"),
  lastReason: text("last_reason"),
  closedAt: ts("closed_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  deletedAt: ts("deleted_at"),
}, (t) => [
  unique("vendor_requests_fest_human_id").on(t.festId, t.humanId),
  check("vendor_requests_total_positive", sql`${t.totalValuePaise} > 0`),
  index("vendor_requests_fest_status_idx").on(t.festId, t.status),
  index("vendor_requests_vendor_idx").on(t.vendorId),
  index("vendor_requests_line_item_idx").on(t.lineItemId),
]);

export const vendorMilestones = pgTable("vendor_milestones", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  vendorRequestId: uuid("vendor_request_id").notNull().references(() => vendorRequests.id),
  kind: milestoneKind("kind").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  plannedPaise: paise("planned_paise").notNull(),
  paidPaise: paise("paid_paise"),
  paidAt: ts("paid_at"),
  paidBy: uuid("paid_by").references(() => users.id),
  paymentReference: text("payment_reference"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [
  check("vendor_milestones_planned_nonneg", sql`${t.plannedPaise} >= 0`),
  index("vendor_milestones_request_idx").on(t.vendorRequestId),
]);

export const incomeEntries = pgTable("income_entries", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  festId: uuid("fest_id").notNull().references(() => fests.id),
  type: incomeType("type").notNull(),
  sourceName: text("source_name").notNull(),
  owningDepartmentId: uuid("owning_department_id").references(() => departments.id),
  pledgedPaise: paise("pledged_paise").notNull().default(0),
  pledgedOn: date("pledged_on"),
  status: incomeStatus("status").notNull().default("PLEDGED"),
  writtenOffReason: text("written_off_reason"),
  notes: text("notes"),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  deletedAt: ts("deleted_at"),
}, (t) => [check("income_pledged_nonneg", sql`${t.pledgedPaise} >= 0`)]);

export const incomeTranches = pgTable("income_tranches", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  incomeEntryId: uuid("income_entry_id").notNull().references(() => incomeEntries.id),
  amountPaise: paise("amount_paise").notNull(),
  receivedOn: date("received_on").notNull(),
  reference: text("reference"),
  recordedBy: uuid("recorded_by").notNull().references(() => users.id),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [
  check("income_tranche_positive", sql`${t.amountPaise} > 0`),
  index("income_tranches_entry_idx").on(t.incomeEntryId),
]);

export const budgetTransfers = pgTable("budget_transfers", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  festId: uuid("fest_id").notNull().references(() => fests.id),
  fromDepartmentId: uuid("from_department_id").references(() => departments.id),
  toDepartmentId: uuid("to_department_id").references(() => departments.id),
  amountPaise: paise("amount_paise").notNull(),
  reason: text("reason").notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [
  check("budget_transfer_positive", sql`${t.amountPaise} > 0`),
  check("budget_transfer_distinct", sql`${t.fromDepartmentId} is distinct from ${t.toDepartmentId}`),
]);

export const tickets = pgTable("tickets", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  festId: uuid("fest_id").notNull().references(() => fests.id),
  humanId: text("human_id").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  requestingDepartmentId: uuid("requesting_department_id").notNull().references(() => departments.id),
  requesterId: uuid("requester_id").notNull().references(() => users.id),
  targetDepartmentId: uuid("target_department_id").notNull().references(() => departments.id),
  assigneeId: uuid("assignee_id").references(() => users.id),
  priority: ticketPriority("priority").notNull().default("MEDIUM"),
  dueAt: ts("due_at").notNull(),
  location: text("location"),
  estimatedCostPaise: paise("estimated_cost_paise"),
  lineItemId: uuid("line_item_id").references(() => lineItems.id),
  status: ticketStatus("status").notNull().default("OPEN"),
  previousStatus: ticketStatus("previous_status"),
  infoRequest: text("info_request"),
  blockedReason: text("blocked_reason"),
  rejectReason: text("reject_reason"),
  escalatedAt: ts("escalated_at"),
  escalatedBy: uuid("escalated_by").references(() => users.id),
  triageRemindedAt: ts("triage_reminded_at"),
  doneRemindedAt: ts("done_reminded_at"),
  triagedAt: ts("triaged_at"),
  startedAt: ts("started_at"),
  doneAt: ts("done_at"),
  closedAt: ts("closed_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  deletedAt: ts("deleted_at"),
}, (t) => [
  unique("tickets_fest_human_id").on(t.festId, t.humanId),
  check("tickets_title_len", sql`char_length(${t.title}) <= 80`),
  check("tickets_cross_department", sql`${t.requestingDepartmentId} <> ${t.targetDepartmentId}`),
  index("tickets_inbox_idx").on(t.targetDepartmentId, t.status, t.priority, t.dueAt),
  index("tickets_outgoing_idx").on(t.requestingDepartmentId, t.status),
  index("tickets_assignee_idx").on(t.assigneeId, t.status),
]);

export const ticketWatchers = pgTable("ticket_watchers", {
  ticketId: uuid("ticket_id").notNull().references(() => tickets.id),
  userId: uuid("user_id").notNull().references(() => users.id),
}, (t) => [primaryKey({ columns: [t.ticketId, t.userId] })]);

export const ticketTemplates = pgTable("ticket_templates", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  festId: uuid("fest_id").notNull().references(() => fests.id),
  name: text("name").notNull(),
  targetDepartmentId: uuid("target_department_id").references(() => departments.id),
  defaultPriority: ticketPriority("default_priority").notNull().default("MEDIUM"),
  fields: jsonb("fields").notNull().default([]),
  isActive: boolean("is_active").notNull().default(true),
});

export const entityLinks = pgTable("entity_links", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  festId: uuid("fest_id").notNull().references(() => fests.id),
  fromType: entityType("from_type").notNull(),
  fromId: uuid("from_id").notNull(),
  toType: entityType("to_type").notNull(),
  toId: uuid("to_id").notNull(),
  relation: text("relation").notNull().default("RELATED"),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [unique("entity_links_unique").on(t.fromType, t.fromId, t.toType, t.toId)]);

export const comments = pgTable("comments", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  festId: uuid("fest_id").notNull().references(() => fests.id),
  entityType: entityType("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  authorId: uuid("author_id").notNull().references(() => users.id),
  body: text("body").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  editedAt: ts("edited_at"),
}, (t) => [index("comments_entity_idx").on(t.entityType, t.entityId, t.createdAt)]);

export const commentMentions = pgTable("comment_mentions", {
  commentId: uuid("comment_id").notNull().references(() => comments.id),
  userId: uuid("user_id").notNull().references(() => users.id),
}, (t) => [primaryKey({ columns: [t.commentId, t.userId] })]);

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  festId: uuid("fest_id").notNull().references(() => fests.id),
  entityType: entityType("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  actorId: uuid("actor_id").references(() => users.id),
  action: text("action").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  reason: text("reason"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [
  index("audit_entity_idx").on(t.entityType, t.entityId, t.createdAt),
  index("audit_fest_idx").on(t.festId, t.createdAt),
]);

export const flags = pgTable("flags", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  festId: uuid("fest_id").notNull().references(() => fests.id),
  entityType: entityType("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  rule: text("rule").notNull(),
  severity: flagSeverity("severity").notNull(),
  explanation: text("explanation").notNull(),
  status: flagStatus("status").notNull().default("OPEN"),
  resolvedBy: uuid("resolved_by").references(() => users.id),
  resolvedAt: ts("resolved_at"),
  resolutionNote: text("resolution_note"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("flags_one_open_per_rule").on(t.entityType, t.entityId, t.rule).where(sql`status = 'OPEN'`),
]);

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  festId: uuid("fest_id").notNull().references(() => fests.id),
  recipientId: uuid("recipient_id").notNull().references(() => users.id),
  type: text("type").notNull(),
  entityType: entityType("entity_type"),
  entityId: uuid("entity_id"),
  title: text("title").notNull(),
  body: text("body"),
  channel: notificationChannel("channel").notNull().default("IN_APP"),
  sentAt: ts("sent_at"),
  readAt: ts("read_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [index("notifications_inbox_idx").on(t.recipientId, t.readAt, t.createdAt.desc())]);

export const humanIdSequences = pgTable("human_id_sequences", {
  festId: uuid("fest_id").notNull().references(() => fests.id),
  prefix: text("prefix").notNull(),
  lastValue: integer("last_value").notNull().default(0),
}, (t) => [primaryKey({ columns: [t.festId, t.prefix] })]);

export const idempotencyKeys = pgTable("idempotency_keys", {
  key: text("key").primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id),
  response: jsonb("response").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});
