# Yugaantar Finance - Verified Workflow Findings

Reviewed against commit `c4fe99a568190fe084276570be2979a6b4cda40a`.

This is a good single-app design for a small internal team. It does not need a rewrite or a different architecture. This note only lists concrete behavior that can produce a wrong record, block a valid workflow, or push people back to WhatsApp.

The repro steps are minimal test cases derived from the current source. They were not run against a live database.

Priority meaning:

- **P0:** Fix before the app becomes the official source of truth.
- **P1:** Fix before relying on close-out reports and flags.
- **P2:** Resolve before fully switching off WhatsApp.

## P0 - Official source-of-truth blockers

### 1. A vendor request can close after a wrong or partial balance payment

**What breaks:** The request becomes `CLOSED` even when most of the balance is still unpaid. The unpaid amount then disappears from Committed and returns to Available.

**Proof:**

- `lib/services/vendors.ts:320-334` accepts any unpaid milestone and any positive `paid_paise`. `RECORD_BALANCE` then sets the request to `CLOSED`.
- `app/api/v1/vendor-requests/[id]/transitions/route.ts:6-23` validates only that `paid_paise` is positive.
- `db/migrations/0001_views.sql:17-22` excludes `CLOSED` requests from Committed.

**Minimal repro:**

1. Create and approve a vendor request with an ₹8,000 balance milestone.
2. Move it to `BALANCE_APPROVED`.
3. Record ₹0.01 against that milestone using `RECORD_BALANCE`.
4. Read the request and budget totals.

**Actual:** The request closes and the unpaid ₹7,999.99 is no longer Committed.

**Expected:** A balance payment must not close the request while any required amount remains unpaid. The action must also match the intended milestone.

### 2. Submitted evidence can still change

**What breaks:** The receipts or invoices reviewed by a HOD or Finance may not be the same evidence later shown in the record.

**Proof:**

- `lib/services/attachments.ts:71-89` freezes removal for later states but omits `SUBMITTED` and `HOD_ENDORSED`.
- `lib/services/attachments.ts:204-220` lets the submitter attach to their reimbursement or vendor request regardless of its current state.
- `app/api/v1/attachments/presign/route.ts:35-55` can bind a new attachment directly to an existing record before the upload is complete.

**Minimal repro:**

1. Submit a reimbursement with a receipt.
2. As the uploader, remove that receipt while the request is `SUBMITTED` or `HOD_ENDORSED`.
3. Request another upload URL with the submitted reimbursement as `entity_id`.
4. Complete the new upload.

**Actual:** Evidence can be removed after submission and new evidence can be added without a resubmission version.

**Expected:** Submitted evidence should remain fixed. Any correction should go through the existing send-back and resubmit flow so reviewers know the record changed.

### 3. The only Management user's own reimbursement can never be paid

**What breaks:** A valid Management reimbursement can reach approval and then remain stuck forever.

**Proof:**

- `lib/services/admin.ts:43-57` permits only one active Management account.
- `lib/authz.ts:293-295` allows only Management to record reimbursement payment and forbids paying one's own request.
- `system_PRD.md:111-119` says Finance HOD should record it with a note when there is only one Management user, but that path is not implemented.

**Minimal repro:**

1. Keep exactly one active Management user.
2. Have that user submit a reimbursement.
3. Have Finance approve it.
4. Try to record payment as the Management user, then try to add another Management user.

**Actual:** The payment is forbidden and the second Management seat is also forbidden.

**Expected:** The documented Finance fallback should be available, or the role rules must allow another valid payer.

### 4. Two requests with the same retry key can both perform the write

**What breaks:** A double click or network retry can create two transfers, tranches, tickets, or requests even though both calls use the same `Idempotency-Key`.

**Proof:**

- `lib/api.ts:148-174` checks the key, runs the complete handler, and only then stores the response.
- `lib/api.ts:181-197` stores with `onConflictDoNothing`, after the business write has already happened.
- `db/schema.ts:793-797` stores only the key, user, and response. It does not bind the key to a route or request body.

**Minimal repro:**

1. Prepare one valid department-to-department budget transfer.
2. Send two copies concurrently with the same user, body, and `Idempotency-Key`.
3. Read the transfer history and both department allocations.

**Actual:** Both calls can pass the initial lookup and apply the transfer twice.

**Expected:** One call should perform the write and the other should replay the same result. Reusing the key with a different route or body should be rejected.

### 5. Concurrent reserve allocations can exceed the fest total

**What breaks:** The sum of department allocations can become larger than the headline fest budget.

**Proof:**

- `lib/services/budget.ts:79-126` locks the affected department rows but does not lock the shared fest row before checking total allocation.
- `app/api/v1/departments/route.ts:62-79` performs the same total check before creating a department, also without a shared lock.

**Minimal repro:**

1. Set the fest total to ₹1,00,000 and existing allocations to ₹80,000.
2. In parallel, transfer ₹15,000 from reserve to Department A and ₹15,000 from reserve to Department B.
3. Read the final sum of department allocations.

**Actual:** Each transaction can see enough reserve and both can commit, leaving ₹1,10,000 allocated.

**Expected:** Only one transfer should succeed because only ₹20,000 was available in reserve.

## P1 - Data and workflow correctness

### 6. Changing a reimbursement's line item can leave the old department attached

**What breaks:** The request can be charged to a line item in one department while routing, visibility, and notifications still treat it as belonging to another department.

**Proof:**

- `lib/services/reimbursements.ts:51-70` derives both `lineItemId` and `departmentId` when the request is created.
- `lib/services/reimbursements.ts:125-140` validates a changed line item but updates only `lineItemId`.

**Minimal repro:**

1. As Finance or Management, create a draft reimbursement against a Department A line item.
2. Patch the draft to use a Department B line item.
3. Read the reimbursement row and its resulting queues or notifications.

**Actual:** `line_item_id` points to Department B while `department_id` remains Department A.

**Expected:** The request's department and selected line item should never disagree.

### 7. Flag state can disappear or become stale without a person resolving it

**What breaks:** A concern raised by a person can dismiss itself, a High vendor invoice mismatch does not stop balance release, and line-item flags may not reflect the current line item.

**Proof:**

- `lib/services/flags.ts:163-194` stores manual flags in the same table as automatic rules.
- `lib/flags/index.ts:22-49` selects every open flag for the entity and dismisses any rule not returned by the current automatic evaluation. It does not exclude manual flags.
- `lib/flags/rules.ts:152-158` marks an invoice mismatch as High, but `lib/services/vendors.ts:347-368` releases the balance without checking open High flags.
- `lib/services/line-items.ts:72-140` and `lib/services/line-items.ts:177-200` do not reevaluate F13/F14 after line-item creation, amount changes, or document removal. Evaluation currently happens on document add and update at lines 361 and 396.

**Minimal repro:**

1. Raise a manual flag on a reimbursement, then edit or transition the reimbursement so automatic rules run. The manual flag becomes `DISMISSED` with `No longer applies`.
2. Confirm vendor delivery with an invoice total different from the approved value, then release the balance. The release succeeds while F9 is open.
3. Remove the last supporting document from a line item above the document threshold. Its F13 state is not refreshed.

**Expected:** Manual concerns should remain until a person resolves them. High vendor flags should be acknowledged before balance release. Line-item flags should match the latest amount and documents.

### 8. Close-out figures and refund history can be wrong

**What breaks:** Projected income can fall below cash already received, unapproved vendor requests appear as contracted money, and refund references are discarded.

**Proof:**

- `db/migrations/0001_views.sql:61-75` keeps received tranches but removes the entire written-off income entry from `expected_paise`.
- `lib/services/exports.ts:321-335` counts `SUBMITTED` and `SENT_BACK` vendor requests as contracted and outstanding.
- `app/api/v1/vendor-requests/[id]/transitions/route.ts:20-22` accepts a refund `reference`, but `lib/services/vendors.ts:391-398` does not store it.

**Minimal repro:**

1. Record a ₹10,000 pledge, receive ₹4,000, then write off the remainder. The view reports ₹4,000 received but ₹0 expected.
2. Submit a vendor request without approval, then export the vendor ledger. Its value appears as contracted and outstanding.
3. Record a refund with a reference, then read the request or audit data. The reference is absent.

**Expected:** Expected cash should never exclude cash already received. Only accepted vendor obligations should be contracted. Every refund should retain its payment reference.

## P2 - Required for replacing WhatsApp

### 9. Member behavior conflicts with the written product rules

**What breaks:** Members may return to WhatsApp for cross-department work, and they cannot see the department budget context the PRD says they should use.

**Proof:**

- `system_PRD.md:62-65` and `system_PRD.md:81-101` say Members see their department summary and may raise a ticket to any department.
- `lib/authz.ts:119-145` deliberately hides department budgets and line-item amounts from Members.
- `lib/services/tickets.ts:53-76` forces a Member's ticket to their own department.

**Minimal repro:**

1. Sign in as a Member and open the reimbursement form. Line-item names appear, but their planned and available amounts do not.
2. As the same Member, create a ticket for another department.

**Actual:** The budget amounts are hidden and the cross-department ticket is rejected.

**Expected:** Either the implementation should follow the PRD, or the PRD should state the intended HOD-only routing. For a WhatsApp replacement, the chosen rule must not leave common cross-team work without an in-app path.

### 10. Urgent notifications are not yet enough to switch off WhatsApp

**What breaks:** A user who has closed the app may not learn about an urgent ticket promptly. Overlapping email workers can also send the same message twice.

**Proof:**

- `system_PRD.md:1661` states that email is the only external notification channel in the current version.
- `README.md:572-574` lists Web Push or WhatsApp delivery for Urgent tickets as not built.
- `lib/services/notifications.ts:150-186` selects unsent email rows, sends them, and only then marks them sent. Two workers can select the same row before either marks it.

**Minimal repro:**

1. Close the app for the receiving user, then raise an Urgent ticket for their department. No device push is sent.
2. Leave one email row pending and start two outbox flushes together. Both can select and send the same row.

**Expected:** Before WhatsApp is removed, urgent work needs a dependable alert outside the open browser, and each queued notification should be delivered once.

## Bottom line

The current architecture is suitable for this team and should stay. Fix the P0 behavior first, verify the P1 records before close-out, and settle the two P2 product behaviors before making this the only internal communication channel.
