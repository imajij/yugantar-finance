# Yugaantar Finance & Operations Dashboard — Product Requirements Document

| | |
|---|---|
| **Status** | Draft v0.3 — build-ready. Sections 1–17 are the product spec; 18–21 are the engineering handoff |
| **Date** | 22 Aug 2026 |
| **Owner** | Finance HOD (to be named) |
| **Fest** | Yugaantar '26 — Scaler School of Technology, Bengaluru. Dates TBD |
| **Website** | https://yugaantar.org — brand tokens in section 9.1 |

---

## 1. Summary

A role-based web dashboard that tracks every rupee of the fest: the headline budget, how it is broken down across departments and line items, every reimbursement and vendor payment from request to payout, and the sponsorship and event-ticket income that funds it. Four roles — Member, Department HOD, Finance HOD, Management — each see exactly what they need and can act only on what they own. An AI layer reads receipts and flags suspicious or out-of-policy requests before money moves.

The same platform carries a **work-ticket system**: any department can ask any other department for a specific piece of work — a poster, a venue setup, forty chairs moved, an advance released — with an owner, a deadline, and a status everyone can see. It replaces pings in WhatsApp groups and is general-purpose, not finance-specific.

Payments themselves happen outside the platform (UPI / bank transfer). The platform is the single source of truth for what was requested, approved, paid, and why.

## 2. Problem

Today fest finances live in spreadsheets, WhatsApp groups, and physical receipts:

- Department HODs don't know how much of their budget is actually left, because approved-but-unpaid and pending requests aren't counted anywhere.
- Reimbursements get lost between the person who spent, the HOD, the finance team, and whoever makes the transfer. Nobody can answer "where is my request?"
- Vendor advances are paid and then forgotten; at closing nobody is sure which balances are still due.
- Management has no live view and has to ask for numbers.
- Duplicate or inflated receipts are caught only by luck.
- Income (sponsorships, event tickets) is tracked separately from spend, so the committee never knows the real cash position.
- Cross-department asks ("can Logistics move the chairs?", "need a poster by Thursday") are WhatsApp pings with no owner, no deadline, and no record of whether they happened.

## 3. Goals and non-goals

**Goals**

1. Every department can see Allocated / Pending / Committed / Spent / Available at any moment, at department and line-item level.
2. A reimbursement moves Member → HOD → Finance → Management with a visible status and a recorded reason at every decision point.
3. Vendor payments are tracked through advance, delivery, and balance, so nothing is owed that the platform doesn't know about.
4. Income is tracked against spend so the fest-level cash position and projected close are always visible.
5. Every money-affecting action is attributable and auditable.
6. Flags surface likely duplicates, mismatches, and over-budget requests before approval.
7. Any department can raise a work ticket to any other department and see it triaged, owned, and closed — from a phone, mid-fest.

**Non-goals (v1)**

- Executing payments. The platform records payments; it does not initiate UPI or bank transfers.
- Accounting / bookkeeping (double-entry ledgers, GST returns, TDS). Exports feed the college accounts office; the platform does not replace it.
- Procurement, tendering, or vendor comparison.
- Event ticketing itself. Event-ticket income is recorded as totals, not per ticket. In this document "ticket" on its own always means a *work ticket* (section 7.7).
- A full project-management tool. Work tickets are deliberately simple: no Gantt charts, sprints, dependencies, or time tracking.
- Multi-fest history and year-over-year analytics. The data model keeps a fest entity so this can come later.

## 4. Assumptions made in this draft

Flag any of these that are wrong — they shape the design.

1. **Line items, not manual marking.** "Feed in a larger figure, break it down, HODs mark what's utilized" is modeled as: Finance HOD sets the fest total and department allocations; each allocation is broken into named line items (e.g. *Tech → Sound system ₹20,000*); every reimbursement and vendor payment is attached to a line item; utilization is **computed from transactions**, not typed in. HODs can additionally mark a line item **Closed** when no more spend is expected, which releases its unspent balance. This keeps the "mark as utilized" intent while making the numbers trustworthy.
2. Both Finance HOD and Department HODs can create and edit line items; Finance HOD is the final authority, and the department cap cannot be exceeded. Line items can carry supporting documents (vendor quotations, web listings, screenshots) so Finance can see the basis for each number. They are optional, with a configurable amount above which at least one is required — off by default.
3. The platform serves one fest at a time. Every record carries a `fest_id` so it can be reused next year.
4. Single currency (INR), single timezone (IST).
5. Members can see their own department's line items and Available figure (read-only), so they don't spend money that isn't there. They cannot see other departments.
6. Payment execution is done by Management from a "payment queue"; the platform records the transaction reference.
7. Over-budget requests are flagged, not blocked, at department and line-item level. The only hard block is the fest total: Finance HOD cannot allocate more than the headline figure.
8. Work tickets reuse the platform's departments, roles, comments, notifications, and audit log rather than living in a separate app. Anyone can raise a ticket to any department; the target department's HOD triages it; Management sees every ticket.

## 5. Users and roles

| Role | Who | What they do |
|---|---|---|
| **Member** | Any department volunteer / core team member | Submits reimbursement requests for money they personally spent; tracks their status. Raises work tickets for their department and works tickets assigned to them. |
| **Department HOD** | Head of one department (Tech, Logistics, Hospitality, Sponsorship, Cultural, …) | Owns the department budget: manages line items within the cap, endorses members' requests, raises vendor payment requests, confirms deliveries. Triages the department's incoming work tickets and assigns them. |
| **Finance HOD** | Head of the finance department (may be more than one person) | Sets the fest total and department allocations, approves or declines every payment, records income, manages users and settings, resolves flags. Acts as HOD for tickets addressed to Finance, and is the platform admin in v1 (open question 14). |
| **Management** | Faculty / committee leadership / college accounts | Watches everything, comments anywhere, executes payments and records them. Cannot originate or approve spend. Can raise work tickets (as "Core") and sees every ticket across the fest. |

### 5.1 Permissions matrix

| Action | Member | Dept HOD | Finance HOD | Management |
|---|:---:|:---:|:---:|:---:|
| View own requests | ✓ | ✓ | ✓ | ✓ |
| View own department budget, line items, requests | ✓ (summary) | ✓ | ✓ | ✓ |
| View all departments | — | — | ✓ | ✓ |
| Submit a reimbursement request | ✓ | ✓ | ✓ ¹ | ✓ ¹ |
| Endorse / send back / decline a department member's request | — | ✓ | ✓ (override, logged) | — |
| Approve / send back / decline a reimbursement | — | — | ✓ | ✓ ² |
| Record payment (mark paid) / put on hold | — | — | — | ✓ |
| Raise a vendor payment request | — | ✓ | ✓ | — |
| Confirm vendor delivery, upload invoice | — | ✓ | ✓ | — |
| Approve vendor request, release balance, cancel | — | — | ✓ | — |
| Create / edit line items (own dept, within cap) | — | ✓ | ✓ (any dept) | — |
| Close / reopen a line item | — | ✓ | ✓ | — |
| Delete a line item (nothing charged against it) | — | ✓ (own dept) | ✓ | — |
| Attach / remove supporting documents on line items | — | ✓ (own dept) | ✓ | — |
| Mark a line item as reviewed | — | — | ✓ | — |
| Set fest total, department allocations, reallocate | — | — | ✓ | — |
| Record income (sponsorship, tickets, grants) | — | — | ✓ | — |
| Comment | ✓ (own requests) | ✓ (own dept) | ✓ | ✓ |
| Manage users, roles, departments, expense types, flag thresholds | — | — | ✓ | — |
| Resolve / dismiss flags | — | — | ✓ | — |
| Export | — | ✓ (own dept) | ✓ | ✓ |
| View audit log | — | ✓ (own dept) | ✓ | ✓ |
| Raise a work ticket to any department | ✓ | ✓ | ✓ | ✓ |
| Triage incoming tickets (accept, assign, prioritize, reject, ask for info) | — | ✓ (own dept) | ✓ (Finance dept) | — |
| Work a ticket (start, block, mark done) | ✓ (if assigned) | ✓ | ✓ | — |
| Close, reopen, cancel, or escalate a ticket | ✓ (own) | ✓ (own dept's) | ✓ | — |
| View tickets | Own, plus own dept's incoming / outgoing | Own dept's incoming / outgoing | Finance dept's, plus any linked to a finance record | All |
| Configure ticket priorities, response targets, templates | — | — | ✓ | — |

¹ Routed so that nobody approves their own request (see 5.2).
² Only for requests submitted by a Finance HOD.

### 5.2 Segregation of duties

Enforced server-side, not just hidden in the UI:

- The submitter of a request can never endorse, approve, or record payment for it.
- A Department HOD's own reimbursement skips endorsement and goes straight to Finance.
- A Finance HOD's own reimbursement is approved by Management (any Management user) instead of Finance.
- A Management user's own reimbursement is approved by Finance and paid by a different Management user (or, if there is only one, recorded by Finance HOD with a note).
- If there are multiple Finance HODs, any of them can approve — except the submitter.

## 6. Core concepts and data model

### 6.1 Entities

Conceptual model. Section 19 is the normative schema.

**Fest** — name, start/end dates, receipt-date window (default: start − 60 days to end + 15 days), total budget, currency.

**Department** — name, HOD(s), allocated amount, status (active / closed).

**Line item** — department, name, planned amount, description, default expense type, status (open / closed), created by, reviewed-by / reviewed-at (Finance HOD, optional), and **supporting documents**: files (quotations, proforma invoices, screenshots) or links (web listings), each with a label, a source (vendor or site), and the quoted amount. Sum of a department's line items must be ≤ its allocation.

**Reimbursement request** — submitter, department, line item, expense type, description / reason, transaction date, amount, receipt file(s), merchant (optional, OCR-filled), payee name, payee UPI ID, status, version history, flags, comments, payment record (reference, date, recorded by, optional proof).

**Vendor** — name, contact, bank details (account, IFSC, holder name) and/or UPI ID, GSTIN (optional), notes. Shared across departments so Finance sees total exposure per vendor.

**Vendor payment request** — department, line item, vendor, description, quote / PO file(s), total value, milestones (MVP: advance + balance; each with planned amount, trigger, paid amount, paid date, reference), expected delivery date, delivery confirmation (date, note, invoice file), status, flags, comments.

**Income entry** — type (sponsorship-cash, sponsorship-in-kind, event ticket sales, college grant, other), source name, owning department (usually Sponsorship), pledged amount, received tranches (amount, date, reference), MoU / invoice file, status (pledged / partially received / received / written off), notes.

**Comment** — attached to any entity; author, text, timestamp, visible to every role that can see the entity.

**Audit event** — entity, actor, action, before/after snapshot, reason, timestamp. Append-only.

**Flag** — entity, rule, severity, explanation, status (open / acknowledged / dismissed), resolved by, resolution note.

**Work ticket** — human-readable ID (YUG-142), title, description, requesting department, requester, target department, assignee, priority, due date-time, location, attachments, estimated cost and optional line item, linked records (reimbursements, vendor requests, other tickets), watchers, state, escalated flag, blocked reason, timestamps (raised, triaged, started, done, closed).

**User** — name, college email, role, department (for Member and Dept HOD), default UPI ID, status.

### 6.2 Budget arithmetic

The same five numbers appear at line-item, department, and fest level. Definitions are fixed so every screen agrees; section 19.4 implements them as SQL views.

```
Allocated     = amount assigned by Finance HOD
Planned       = Σ line item amounts               (≤ Allocated; the gap is the dept's unplanned buffer)
Pending       = Σ requests awaiting a decision     (SUBMITTED, HOD_ENDORSED, vendor SUBMITTED)
Committed     = Σ approved but not yet paid        (APPROVED, ON_HOLD, unpaid milestones of approved vendor requests)
Spent         = Σ paid                             (PAID, paid vendor milestones, net of vendor refunds)
Available     = Allocated − Pending − Committed − Spent
Utilization % = (Committed + Spent) / Allocated
```

Pending is subtracted from Available so a department can't double-spend against money that is already in the approval queue. The UI shows Pending separately so HODs understand why Available is lower than they expect.

When a vendor request is approved, its **entire** value moves to Committed. As each milestone is paid, that amount moves from Committed to Spent. If Finance reduces the balance at release (partial delivery, penalty), the difference returns to Available.

### 6.3 Fest-level arithmetic

```
Total budget        = the headline figure entered by Finance HOD
Reserve             = Total budget − Σ department Allocated
Income pledged      = Σ income entries (pledged), by type
Income received     = Σ income entries (received), by type
Cash position       = Income received − Spent (all departments)
Projected close     = Income expected − (Spent + Committed + Pending)
                      where Income expected = received + pledged-not-yet-received,
                      excluding written-off and in-kind
```

In-kind sponsorship is shown for completeness but never counts toward cash.

## 7. Flows

### 7.1 Budget setup

1. Finance HOD creates the fest (name, dates, receipt window) and enters the total budget.
2. Finance HOD creates departments and assigns each an allocation. Σ allocations ≤ total; the remainder is Reserve.
3. Finance HOD and/or each Department HOD break the allocation into line items. Σ line items ≤ allocation (hard validation). Each line item can carry **supporting documents** that justify the number:
   - Files — vendor quotations, proforma invoices, screenshots. PDF / JPG / PNG / HEIC, ≤ 10 MB each, up to 10 per line item.
   - Links — web listings (an Amazon or IndiaMART page, a rental site). The URL plus an optional screenshot, because listings change.
   - Each document carries a label, a source (vendor or site), and the quoted amount, so Finance can compare the planned amount against its quotes at a glance. Three quotes for one item is the normal case.
   - Documents stay visible on the line item, in the department statement export, and on every request attached to that line item.
   - A fest setting (`line_item_doc_threshold_paise`, **default 0 — off**) sets the amount at or above which a line item must have at least one document before requests can attach to it. While it is 0, documents are optional at every amount: the gate fell on the person filing a claim rather than the person who planned the line item, and nothing they could do cleared it. Set it to an amount in paise to re-arm it for one fest; flag F13 and the budget-review ordering follow the same setting.
   - Finance HOD can mark a line item **Reviewed** after looking at its documents. Unreviewed items above the threshold are listed first on the Finance budget-review screen. Whether this should become a hard approval gate is open question 20.
4. Finance HOD invites users by college email and assigns roles and departments.
5. Finance HOD configures expense types and flag thresholds (sensible defaults provided).

Allocations and line items can be revised at any time (see 7.5); every change is logged with a reason.

### 7.2 Reimbursement flow

**Who:** Member submits → Department HOD endorses → Finance HOD approves → Management pays.

**Form fields**

| Field | Required | Notes |
|---|:---:|---|
| Receipt(s) | ✓ | Image or PDF, ≤ 10 MB each, up to 5. Camera capture on mobile. |
| Proof of payment | ✓ | Image or PDF, ≤ 10 MB each, up to 3: a UPI screenshot, card slip or bank statement line showing the claimant paid. Stored as `CLAIM_PAYMENT_PROOF`, distinct from Finance's `PAYMENT_PROOF` for the payout. |
| Line item | ✓ | Dropdown of the member's department's open line items, showing Available for each. |
| Expense type | ✓ | Configurable list. Defaults: Food & Beverages, Travel & Transport, Printing & Stationery, Equipment Rental, Decor & Props, Prizes & Gifts, Marketing & Promotion, Accommodation, Miscellaneous. |
| Reason / description | ✓ | What it was for. Minimum 10 characters. |
| Transaction date | ✓ | Date on the receipt. Flagged (not blocked) if outside the fest receipt window. |
| Amount (₹) | ✓ | > 0, two decimals. |
| Merchant | — | Prefilled by OCR when available. |
| Payee name | ✓ | Defaults to the submitter. |
| Payee UPI ID | ✓ | Defaults from the user profile; validated against `^[\w.\-]{2,}@[a-zA-Z]{2,}$`. |

**States**

| State | Meaning | Editable by submitter? |
|---|---|:---:|
| DRAFT | Saved, not submitted | ✓ |
| SUBMITTED | Awaiting Department HOD | — |
| SENT_BACK | Returned for changes with a reason (by HOD or Finance) | ✓ |
| HOD_ENDORSED | Awaiting Finance HOD | — |
| APPROVED | Awaiting payment by Management | — |
| ON_HOLD | Management paused payment; awaiting Finance resolution | — |
| PAID | Terminal. Payment reference recorded | — |
| DECLINED | Terminal. Reason recorded | — |
| WITHDRAWN | Terminal. Submitter withdrew before payment | — |

**Transitions**

| From | Action | By | To |
|---|---|---|---|
| DRAFT | Submit | Member | SUBMITTED |
| SUBMITTED | Endorse | Dept HOD | HOD_ENDORSED |
| SUBMITTED | Send back (reason required) | Dept HOD | SENT_BACK |
| SUBMITTED | Decline (reason required) | Dept HOD | DECLINED |
| SENT_BACK | Edit and resubmit | Member | SUBMITTED (new version; old version kept) |
| HOD_ENDORSED | Approve (must acknowledge open High flags with a note) | Finance HOD | APPROVED |
| HOD_ENDORSED | Send back (reason required) | Finance HOD | SENT_BACK |
| HOD_ENDORSED | Decline (reason required) | Finance HOD | DECLINED |
| APPROVED | Record payment (reference, date, optional screenshot) | Management | PAID |
| APPROVED | Hold (reason required) | Management | ON_HOLD |
| ON_HOLD | Resolve (note) | Finance HOD | APPROVED |
| ON_HOLD | Decline (reason required) | Finance HOD | DECLINED |
| Any non-terminal | Withdraw | Member | WITHDRAWN |

**Special routing**

- Submitter is a Department HOD → starts at HOD_ENDORSED.
- Submitter is a Finance HOD → the Approve action is performed by Management.
- A request sent back more than twice is surfaced in the Finance flags panel (pattern of poor submissions, or unclear policy).

**Behaviors**

- Every state change records actor, timestamp, and reason, and triggers notifications (section 10).
- Finance HOD's queue shows flagged requests first, then oldest first. Bulk approve is available for unflagged requests.
- Each request shows its age; it turns amber after 3 days without action and red after 7.
- Receipt files are immutable once submitted; a resubmission creates a new version with the old files retained.
- Line-item and department Available are recomputed on every transition.

### 7.3 Vendor payment flow

Covers anything where money goes to an outside party in stages — sound/light rental, stage fabrication, catering, printing.

**Who:** Department HOD raises → Finance HOD approves → Management pays advance → Department HOD confirms delivery → Finance HOD releases balance → Management pays balance.

**Request fields:** vendor (pick existing or create), line item, description, quote / PO file(s), total value, advance amount (₹ or %), balance amount (computed), advance due (on approval / on a date), expected delivery date, vendor payment details (bank or UPI), notes.

**States**

| State | Meaning |
|---|---|
| DRAFT | Saved, not submitted |
| SUBMITTED | Awaiting Finance HOD |
| SENT_BACK | Returned with reason; editable |
| APPROVED | Full value moves to Committed. Advance awaiting payment |
| ADVANCE_PAID | Management recorded the advance (reference, date). Skipped if advance = 0 |
| DELIVERED | Dept HOD confirmed delivery with date, note, and invoice upload |
| BALANCE_APPROVED | Finance HOD released the balance (amount may be adjusted with a reason). Skipped if balance = 0 |
| CLOSED | Terminal. Balance paid and recorded, or fully settled |
| DECLINED | Terminal |
| CANCELLED | Terminal. If an advance was paid, "refund expected / refund received" is tracked until settled |

**Transitions**

| From | Action | By | To |
|---|---|---|---|
| DRAFT | Submit | Dept HOD | SUBMITTED |
| SUBMITTED | Approve | Finance HOD | APPROVED |
| SUBMITTED | Send back / Decline (reason) | Finance HOD | SENT_BACK / DECLINED |
| SENT_BACK | Edit and resubmit | Dept HOD | SUBMITTED |
| APPROVED | Record advance payment | Management | ADVANCE_PAID |
| APPROVED / ADVANCE_PAID | Confirm delivery (invoice required) | Dept HOD | DELIVERED |
| DELIVERED | Release balance (amount editable with reason) | Finance HOD | BALANCE_APPROVED |
| BALANCE_APPROVED | Record balance payment | Management | CLOSED |
| DELIVERED, balance = 0 | Close | Finance HOD | CLOSED |
| APPROVED / ADVANCE_PAID | Cancel (reason; refund tracking if advance paid) | Finance HOD | CANCELLED |

**Behaviors**

- The vendor page shows every request across departments: total contracted, paid, outstanding. Finance sees total exposure per vendor.
- Expected delivery date passing without confirmation → reminder to Dept HOD and a Medium flag (F12).
- Milestones are stored as a list so more than two (e.g. 30 / 40 / 30) can be supported later without a schema change.
- An invoice total that differs from the approved value raises a High flag (F9) before balance release.
- A refund received on a cancelled request is recorded against the line item and reduces Spent.

### 7.4 Income tracking

**Who:** Finance HOD records; everyone with fest-level view sees totals. (Open question 6: whether the Sponsorship HOD can record pledges directly.)

| Type | Entered as | Counts toward cash? |
|---|---|:---:|
| Sponsorship — cash | One entry per sponsor: pledged amount, received tranches with dates and references, MoU upload | ✓ |
| Sponsorship — in-kind | One entry per sponsor: estimated value, what was provided | — |
| Event ticket sales | Periodic totals (daily during the fest, or per event) with source (gate, online platform) and reference | ✓ |
| College grant | One entry per tranche | ✓ |
| Other | Free-form | ✓ |

**Behaviors**

- Each sponsor shows pledged vs received and days since pledge; unreceived pledges older than 30 days are highlighted.
- Written-off pledges are excluded from Income expected but retained for the record.
- Income ledger export and a sponsor-wise statement are available (section 12).
- The fest overview shows Income received vs Spent (cash position) and Income expected vs Spent + Committed + Pending (projected close).

### 7.5 Reallocation and line-item lifecycle

- **Between departments / reserve:** Finance HOD moves an amount from A to B (or from Reserve) with a mandatory reason. Both HODs are notified. A department's allocation cannot drop below its Committed + Spent.
- **Within a department:** Dept HOD can add, rename, resize, or close line items as long as Σ line items ≤ allocation and no line item drops below its own Committed + Spent.
- **Closing a line item:** no new requests can attach to it; its unspent balance returns to the department's unplanned buffer. Finance HOD can pull buffer back to Reserve. Closed items can be reopened by the HOD with a reason.
- **Supporting documents** can be added or removed while a line item is open. Removal is soft (file retained, marked removed) and logged.
- **Deleting a line item:** allowed only while nothing has been charged against it — no reimbursement request and no vendor request, whatever their state. The planned amount returns to the department's unplanned buffer, the row is kept (soft delete), open flags on it are dismissed as no longer applying, and the deletion is logged. Once anything is filed against it the delete is refused with `CONFLICT`; closing it is the way to retire an item that has history, because the five numbers read the line item and money that has moved cannot be made to disappear from them.
- All of the above write audit events showing before and after values.

### 7.6 Comments

Any user can comment on an entity they can see. Comments are visible to everyone else who can see that entity, are timestamped, cannot be deleted (editable for 5 minutes, then marked "edited"), and support @-mentioning users who can see the entity. This is the channel Management uses to ask "why is this ₹40,000?" without leaving the platform.

### 7.7 Work tickets (inter-department requests)

**Purpose.** One place for any department to ask any other department for a specific piece of work, with an owner, a deadline, and a status everyone can see. It is general-purpose: "Design — poster for the dance finals by Thursday", "Logistics — 40 chairs to Audi B before 4 pm", "Tech — mic check on the main stage at 9", "Finance — release the caterer's advance". Throughout this document "ticket" on its own means a work ticket; event-ticket income is always called that.

**Who does what**

- **Raise:** any user, on behalf of their own department, to exactly one target department. Management raises as "Core".
- **Triage:** the target department's HOD — accept (assign, confirm or adjust priority and due), ask for info, or reject with a reason. Finance HOD triages tickets addressed to Finance.
- **Work:** the assignee (a member of the target department, or the HOD) — start, mark blocked with a reason, mark done with an optional proof photo or note.
- **Close:** the requester confirms the work is done, or reopens it with a reason. Tickets auto-close 48 hours after Done if the requester is silent.
- **Watch and comment:** anyone in either department, plus Management. Requester, target HOD, and assignee are watchers by default.
- **Escalate:** the requester or either HOD can escalate a ticket that is untriaged past its response target, Blocked, or Rejected. Escalation notifies Management and both HODs and marks the ticket; it does not change the state.

**Fields**

| Field | Required | Notes |
|---|:---:|---|
| Title | ✓ | ≤ 80 characters |
| Description | ✓ | What, where, and what "done" looks like |
| Requesting department | ✓ | Set from the requester's profile |
| Target department | ✓ | Exactly one. Work needing several departments = one ticket per department, linked as related |
| Priority | ✓ | Low / Medium / High / Urgent. Default Medium. Target HOD may change it at triage |
| Due date and time | ✓ | Target HOD may adjust at triage; the requester is notified |
| Location | — | Venue / room / stage |
| Attachments | — | Images, PDFs, links (reference designs, floor plans) |
| Estimated cost and line item | — | If the work needs money. From the ticket, the target HOD can raise a vendor request or a member can attach a reimbursement; the ticket shows the linked record and its state |
| Linked records | — | Reimbursements, vendor requests, other tickets |

**States**

| State | Meaning |
|---|---|
| OPEN | Raised, awaiting triage by the target HOD |
| NEEDS_INFO | Target department asked a question; back with the requester |
| ACCEPTED | Triaged: assigned (or queued for the department), priority and due confirmed |
| IN_PROGRESS | Assignee has started |
| BLOCKED | Assignee cannot proceed; reason recorded (waiting on another department, on money, on a venue) |
| DONE | Assignee marked complete; awaiting requester confirmation |
| CLOSED | Terminal. Requester confirmed, or auto-closed 48 h after DONE |
| REJECTED | Terminal. Target HOD declined with a reason; requester may escalate or raise a revised ticket |
| CANCELLED | Terminal. Requester withdrew |

**Transitions**

| From | Action | By | To |
|---|---|---|---|
| OPEN | Accept (assign, confirm priority and due) | Target HOD | ACCEPTED |
| OPEN / ACCEPTED / IN_PROGRESS | Ask for info (question required) | Target HOD or assignee | NEEDS_INFO |
| NEEDS_INFO | Reply | Requester | Previous state |
| OPEN | Reject (reason required) | Target HOD | REJECTED |
| ACCEPTED | Start | Assignee | IN_PROGRESS |
| IN_PROGRESS | Block (reason required) | Assignee | BLOCKED |
| BLOCKED | Unblock | Assignee or target HOD | IN_PROGRESS |
| ACCEPTED / IN_PROGRESS | Mark done (optional proof) | Assignee or target HOD | DONE |
| DONE | Confirm | Requester or requesting HOD | CLOSED |
| DONE | Reopen (reason required) | Requester or requesting HOD | IN_PROGRESS |
| DONE | 48 h with no response | System | CLOSED |
| ACCEPTED / IN_PROGRESS / BLOCKED | Reassign within department | Target HOD | Same state |
| Any non-terminal | Cancel | Requester or requesting HOD | CANCELLED |

**Priority and response targets** (defaults; configurable by the platform admin)

| Priority | Triage within (fest days / other days) | Done by |
|---|---|---|
| Urgent | 30 min / 2 h | The due time, same day. Notifies every member of the target department, not just the HOD |
| High | 2 h / 8 h | Due date |
| Medium | 1 day / 1 day | Due date |
| Low | 3 days / 3 days | Due date |

Triage overdue → reminder to the target HOD; overdue by a second interval → automatic escalation to Management and the requesting HOD. Due date passed without DONE → both HODs and the assignee are notified, and the ticket is highlighted on every board it appears on.

**Boards and views**

- **Department inbox** — Kanban (Open / Accepted / In progress / Blocked / Done) of tickets addressed to my department, sorted by priority then due. Overdue and escalated tickets carry a marker.
- **Outgoing** — tickets my department raised, with state and who owns them.
- **My tickets** — assigned to me.
- **Fest-wide board** (Management; optionally read-only for HODs, open question 13) — every ticket, filterable by department, priority, state, overdue; plus **workload by department**: open tickets by priority, so it is obvious which department is drowning.
- Calendar view by due date — v1.1.

**Behaviors**

- Every change writes to the ticket's timeline (reusing the audit log): who, when, what, reason.
- Comments and @-mentions reuse 7.6. Comments on a ticket are the expected place to negotiate scope, not a side chat.
- When a ticket is raised, the form shows similar open tickets addressed to the same department (title similarity) to prevent double-asking.
- The target HOD can bulk-assign and bulk-prioritize from the inbox.
- A reimbursement or vendor request can point at the ticket that asked for the work, so "why was this spent?" is answerable from the finance record.
- Raising, updating, and marking done all work from a phone; proof-of-done accepts a camera photo.
- **Templates (v1.1):** common request types with prefilled fields — Design request (dimensions, copy, deadline), Logistics move (items, from, to, by when), Tech setup (venue, equipment, time), Hospitality (headcount, timing), Finance (auto-links to a vendor or reimbursement record).

## 8. AI features

### 8.1 Receipt reading (OCR auto-fill)

On upload, the receipt image / PDF is sent to a vision-capable model which returns merchant, date, total, tax, and line items as structured JSON. The form is prefilled and marked "auto-filled — please confirm." The extracted JSON is stored with the request and used by flag rules F2, F3, and F7. Extraction must handle photographed paper receipts, UPI app screenshots, and PDF invoices.

### 8.2 Flag rules

| # | Rule | Trigger | Severity |
|---|---|---|:---:|
| F1 | Duplicate receipt | Perceptual hash matches an existing receipt in this fest, or same amount + date + merchant already submitted by anyone | High |
| F2 | Amount mismatch | OCR total differs from entered amount by > ₹50 or > 5% | High |
| F3 | Unreadable receipt | OCR can't find a total or a date | Medium |
| F4 | Date outside window | Transaction date outside the fest receipt window | Medium |
| F5 | Over budget | Approval would take the line item or department Available below zero | High |
| F6 | Repeated payee | Same UPI ID on more than 5 requests, or more than ₹25,000 cumulative, in this fest | Medium |
| F7 | Category mismatch | Description / expense type / line item inconsistent with receipt contents (model-judged) | Low |
| F8 | Large advance | Vendor advance > 50% of contract value | Medium |
| F9 | Invoice ≠ contract | Vendor invoice total differs from the approved value | High |
| F10 | Split submission | Several requests from the same payee on the same day that together exceed a single-request threshold | Low |
| F11 | Unusual amount | Amount > 3× the median for that expense type in this fest (after 10+ samples) | Low |
| F12 | Delivery overdue | Vendor expected delivery date passed with no confirmation | Medium |
| F13 | Missing support | Line item at or above the document threshold with no supporting document | Medium |
| F14 | Above quote | Line item planned amount exceeds the lowest quoted amount on its documents by more than 20% | Low |

Thresholds are configurable by Finance HOD. F1–F6, F8, F9, F12–F14 are deterministic; F7, F10, F11 use the model or statistics and ship after the deterministic set.

### 8.3 Flag behavior

- Flags are **advisory**. Nothing is auto-declined.
- Flags are evaluated on submit, on every edit, on endorsement, and on line-item changes (F13, F14). Results are shown to the Department HOD at endorsement and to Finance HOD at approval, with a plain-language reason (e.g. "Receipt total reads ₹1,240 but ₹2,140 was entered").
- Approving a request with an open High flag requires an acknowledgement note from Finance HOD. Flags can be dismissed with a reason; both are logged.
- A flags panel on the Finance dashboard lists all open flags across the fest, sorted by severity and age.
- Management sees flag history on every request they pay.

### 8.4 Later

- Natural-language questions over the ledger ("how much has Logistics spent on transport?").
- Weekly digest for Management: spend vs plan, open flags, overdue vendors, income received.
- Receipt tampering detection (edited totals, reused templates).
- Vendor price benchmarking across fests.
- For work tickets: suggest target department and priority from the description; surface similar open tickets before a new one is raised; daily "at risk" list (unassigned Urgent, Blocked, overdue).

## 9. Dashboards and screens

**Member**
- My requests: list with status chips and a per-request timeline (who did what, when, comments).
- New request (mobile-first, camera capture, OCR prefill).
- My department: line items with Available, read-only.
- Raise a ticket; My tickets (assigned to me); Tickets I raised.

**Department HOD**
- Department overview: Allocated / Pending / Committed / Spent / Available as cards; line-items table with utilization bars; recent activity.
- To endorse: queue of SUBMITTED requests with flags, receipt preview, and Available impact.
- Vendor payments: list by state, overdue deliveries highlighted.
- Line items: create / edit / close; attach quotations and web listings; items below the document threshold are marked.
- Ticket inbox (Kanban) and Outgoing, with the department's open-ticket count by priority in the header.
- Everything a Member has.

**Finance HOD**
- Fest overview: total budget, allocated vs reserve, income received vs spent (cash position), projected close, department table (five numbers + utilization bar), open flags count, items awaiting decision.
- Approval queue: reimbursements and vendor requests, flagged first, with bulk approve for clean items.
- Flags panel.
- Income ledger and sponsor statements.
- Vendors: exposure per vendor.
- Reallocation and budget setup.
- Budget review: every line item with its documents and a quote-vs-planned comparison, unreviewed items above the threshold first.
- Finance ticket inbox, plus every ticket linked to a finance record.
- Admin: users, roles, departments, expense types, flag thresholds, ticket priorities and response targets, templates, fest settings.
- Audit log with filters.

**Management**
- Fest overview (same as Finance, read-only).
- Payment queue: everything APPROVED / BALANCE_APPROVED, grouped by payee, with one-click "record payment" (reference, date, screenshot) and "hold". Downloadable as a payment batch (section 12).
- Department drill-down, vendor drill-down, income — read-only with comments.
- Fest-wide ticket board, workload by department, escalations. Raise a ticket as "Core".
- Audit log.

### 9.1 Brand and visual design

The tokens below were read from the source of yugaantar.org (repository `visy-ani/yugaantar-frontend`, last commit Oct 2025). The site already contains a dark "Dashboard" page; this platform adopts that page's palette so it feels like part of the fest site rather than a generic admin tool.

**Palette**

```css
:root {
  /* Surfaces */
  --yg-bg:           #06061f;  /* landing background; sign-in screen */
  --yg-bg-app:       #13141f;  /* app background */
  --yg-surface:      #1a1b2e;  /* cards, sidebar, table rows */
  --yg-surface-2:    #2a2b3d;  /* borders, dividers, hover, avatars */

  /* Brand accents */
  --yg-lime:         #d2fc3c;  /* logo, fest name, active nav, primary actions */
  --yg-lime-bright:  #c1ff00;  /* the site's dashboard page uses this variant; standardize on #d2fc3c */
  --yg-yellow:       #EECE00;  /* the single most important CTA on a screen */
  --yg-yellow-title: #FFD500;  /* title artwork only */
  --yg-pink:         #f5449e;  /* secondary buttons, links */
  --yg-sky:          #7fd5ff;  /* highlighted text */
  --yg-violet:       #5119db;  /* nav gradient start (landing only) */
  --yg-crimson:      #b12a36;  /* nav gradient end (landing only) */

  /* Text */
  --yg-text:         #ffffff;
  --yg-text-soft:    #c0c0c0;
  --yg-text-muted:   #a0a0b0;
  --yg-on-accent:    #06061f;  /* text on lime or yellow */
}
```

**Semantic colors for money and ticket states.** Brand colors never encode a state; states get their own palette, tuned for the dark surfaces. The green and red pairs are the site's existing status-chip colors. (The site uses the red pair for "pending" — not carried over; pending is amber here.)

| Meaning | States | Text | Background |
|---|---|---|---|
| Waiting on someone | DRAFT, SUBMITTED, HOD_ENDORSED, OPEN, NEEDS_INFO, Pending | `#f5c542` | `#3d2f0a` |
| Moving | ACCEPTED, IN_PROGRESS, ADVANCE_PAID, DELIVERED | `#7fd5ff` | `#0e2a3d` |
| Decided, one step left | APPROVED, BALANCE_APPROVED, DONE, Committed | `#d2fc3c` | `#263a0a` |
| Finished well | PAID, CLOSED, Spent | `#90ee90` | `#1f4d1f` |
| Finished badly | DECLINED, REJECTED, CANCELLED, WITHDRAWN | `#ee9090` | `#4d1f1f` |
| Stuck | ON_HOLD, BLOCKED, SENT_BACK | `#b39dff` | `#241452` |
| Flag — High / Medium / Low | | `#ee9090` / `#f5c542` / `#a0a0b0` | matching dark tints |

All pairs above, and all brand text on `--yg-surface`, clear WCAG AA (4.5:1); re-check in the design tool before shipping.

**Typography** (all already loaded by the site from Google Fonts)

| Use | Font |
|---|---|
| UI text, forms, tables, buttons | Lexend (400 / 500 / 700) |
| Page titles, section headings, labels on the five big numbers | Reem Kufi Fun |
| Amounts, references (UTR), ticket IDs, dates in tables | Source Code Pro, `font-variant-numeric: tabular-nums`, right-aligned |
| Not used inside the app | LC Mogi, Monomaniac One, Sriracha, Poppins — fest-poster display fonts. LC Mogi and Monomaniac One may appear on the sign-in screen only |

**Logo and assets** (paths in the website repository)

| Asset | Path | Use |
|---|---|---|
| Wordmark | `public/YugaantarLogo.svg` — 166 × 60, lime wordmark with an "EST FEST 2024" badge | App header at 120–166 px wide, on dark surfaces only. It is a PNG wrapped in SVG: ask Design for the vector original before using it larger or in print |
| Title artwork | `src/assets/Images/Title.svg` (#FFD500) | Sign-in screen only |
| Landing art | `src/assets/Images/BgLeft.png`, `BgRight.png`; `public/Cloud_1.svg`, `Cloud_2.svg`, `Mermaid.png`; `src/assets/Images/Street.svg` | Sign-in screen hero; nothing inside the app |
| Icons | lucide-react (the site's icon set), plus `public/Calendar.svg`, `MapPin.svg` | Everywhere |
| Social | `src/assets/Images/{Instagram, Discord, LinkedIn, X, Youtube}.svg` | Footer of emails and exports, if needed |
| Favicon | None yet — the site ships the default Vite icon | Needs a lime "Y" mark from Design (open question 19) |

**Rules**

1. Dark theme by default, matching the site's own dashboard page. A light theme for faculty preference is a v1.1 item (open question 18); emails and PDF exports are light regardless.
2. Lime (`--yg-lime`) is the primary-action and active-state color. Yellow (`--yg-yellow`) is reserved for the one most important action on a screen — Submit, Approve, Record payment, Accept ticket. Pink is for secondary buttons and links only.
3. Money and ticket states use the semantic palette only, as pill chips (border-radius 999px, like the site's) with a text label — never color alone.
4. Amounts always in Source Code Pro, tabular numerals, ₹ prefix, Indian grouping (₹1,23,456.00), right-aligned in tables.
5. Chrome stays restrained: no gradients, background art, or display fonts inside the app. The landing-page treatment (gradient nav, clouds, LC Mogi title) is allowed on the sign-in screen so the hand-off from yugaantar.org feels continuous.
6. Emails and PDF exports use the light variant: white background, `--yg-bg` text, lime only on the header bar, and the wordmark.

## 10. Notifications

Email in v1. Push or WhatsApp must be live before fest week for Urgent tickets — email is too slow on the ground (see section 14).

| Event | Recipients |
|---|---|
| Request submitted | Dept HOD |
| Request endorsed | Finance HOD(s) |
| Request sent back / declined | Submitter (+ Dept HOD if by Finance) |
| Request approved | Submitter, Dept HOD, Management |
| Payment recorded | Submitter, Dept HOD |
| Payment put on hold | Finance HOD, submitter |
| Vendor request submitted / approved / advance paid / balance approved / closed | Dept HOD, Finance HOD, Management as relevant |
| Delivery confirmed | Finance HOD |
| Delivery overdue | Dept HOD, Finance HOD |
| High flag raised | Finance HOD |
| Reallocation | Both affected Dept HODs |
| @-mention in a comment | Mentioned user |
| Daily digest (pending decisions, open flags, overdue items) | Finance HOD, Management (opt-in for HODs) |
| Work ticket raised | Target department HOD (every target-department member if Urgent) |
| Ticket accepted / assigned / reassigned | Requester; assignee |
| Ticket needs info | Requester |
| Ticket in progress / blocked / done | Requester and watchers |
| Ticket done, awaiting confirmation | Requester (reminder at 24 h; auto-close at 48 h) |
| Ticket rejected | Requester, requesting department HOD |
| Triage overdue | Target HOD; after a second interval, Management and requesting HOD |
| Ticket due date passed | Both HODs, assignee |
| Ticket escalated | Management, both HODs |

## 11. Audit, controls, and data retention

- Append-only audit log for every create / update / state change / payment record / reallocation / flag resolution, with actor, timestamp, before/after, and reason.
- No hard deletes. Records are soft-deleted or moved to terminal states; files are retained.
- Segregation of duties as in 5.2, enforced in the API layer.
- Receipt, invoice, and MoU files are stored privately and served through signed, expiring URLs; only users who can see the parent record can fetch them. One exception, by decision: the bill links in the reimbursement export open for anyone who holds the link, with no sign-in, so the file can go to someone without an account. They cover bills on reimbursements only, and stop working when the bill is removed or the claim is deleted.
- Data retained for at least two years after fest close for college audit; Finance HOD can export a full archive.
- Amounts stored as integers in paise to avoid rounding errors.

## 12. Reports and exports

All exports are CSV and XLSX, filterable by date range, department, state, line item, expense type, vendor, payee.

1. **Transactions ledger** — every reimbursement and vendor milestone with full status history.
2. **Department statement** — line items with the five numbers, the transactions behind each, and links to supporting documents.
3. **Payment batch** — all APPROVED / BALANCE_APPROVED items: request ID, payee, UPI / bank details, amount. This is what Management works from when making transfers.
4. **Vendor ledger** — per vendor: contracted, paid, outstanding, refunds.
5. **Income ledger** — per source: pledged, received, dates, references; sponsor-wise statement.
6. **Fest summary** — total budget, income by type, spend by department and expense type, cash position, projected close, open items. Intended as the closing report handed to the college.
7. **Audit log export** — for a date range or entity.

## 13. Authentication and access

- Sign-in with the college Google Workspace account, restricted to the college domain. Fallback: invite link to a specific email address for external Management users.
- Finance HOD assigns role and department per user. One role per user per fest.
- Sessions expire after 7 days; sensitive actions (approve, record payment, reallocate) re-verify the session server-side.
- All authorization checks happen in the API, never only in the UI.

## 14. Non-functional requirements

- **Mobile-first submission.** Members will submit from phones in the middle of the fest. Camera capture, client-side image compression, resumable upload.
- **Live where it matters.** Ticket boards and approval queues update without a manual refresh; Urgent tickets reach the target department by push or WhatsApp within a minute on fest days.
- **Files:** JPG, PNG, HEIC, PDF; ≤ 10 MB each; up to 5 per request, up to 10 per line item.
- **Scale (sizing assumption):** ~15 departments, ~200 users, ~1,500 reimbursements, ~100 vendor requests, ~100 income entries, ~800 work tickets per fest. Correctness matters far more than throughput.
- **Availability:** no planned downtime during fest week; daily backups with point-in-time restore.
- **Performance:** dashboards load in under 2 s on a mid-range phone over mobile data; OCR result within 15 s of upload (the form is usable before it returns).
- **Currency / locale:** INR with Indian digit grouping (₹1,23,456.00), IST, dates as DD MMM YYYY.
- **Accessibility:** keyboard-navigable, sufficient contrast, no reliance on color alone for status.

## 15. Phasing

**MVP — must be live before department budgets are released**
- Auth, roles, departments, users (sections 5, 13)
- Budget setup with line items, supporting documents, and the five-number arithmetic (6, 7.1)
- Reimbursement flow end-to-end, including special routing (7.2)
- Vendor payment flow with advance + balance (7.3)
- Income ledger: sponsorship cash, in-kind, event tickets, grants (7.4)
- Reallocation, line-item close (7.5), comments (7.6)
- Deterministic flags F1–F6, F8, F9, F12–F14 and flag behavior (8.2, 8.3)
- Work tickets: raise, triage, assign, work, close; department inbox, outgoing, my tickets; Management fest-wide board (7.7)
- All four dashboards (9), brand theme (9.1), email notifications (10), audit log (11), exports 1–3 and 6 (12)

**v1.1 — during the fest run-up**
- Receipt OCR auto-fill (8.1) and model-based flags F7, F10, F11
- Remaining exports (4, 5, 7)
- Daily digest, WhatsApp notifications
- Bulk approve, payment batch improvements
- Department cash advances / imprest settlement, if open question 3 says yes
- Ticket templates, similar-ticket suggestion, calendar view, workload-by-department chart
- Push / WhatsApp delivery for Urgent tickets (must ship before fest week)
- Light theme (9.1)

**Later**
- Natural-language queries, management weekly digest, tampering detection
- Multi-fest history and year-over-year comparison
- Vendor self-service portal (upload invoice, see payment status)
- AI routing and at-risk digest for tickets (8.4)

## 16. Success metrics

| Metric | Target |
|---|---|
| Median time from submission to payment recorded | < 5 days |
| Requests approved without a send-back | ≥ 85% |
| Vendor balances unknown at fest close | 0 |
| "Where do we stand?" questions from Management answered by the overview alone | 100% |
| Duplicate receipts reaching payment | 0 |
| End-of-fest reconciliation with college accounts completed | within 7 days of fest close |
| HOD satisfaction ("I always knew how much I had left") | ≥ 4 / 5 in post-fest survey |
| Urgent tickets triaged within 30 minutes on fest days | ≥ 90% |
| Tickets closed by their due date | ≥ 85% |
| Cross-department asks made outside the platform during fest week | Near zero, spot-checked in the post-fest review |

## 17. Open questions

1. Should line items be created centrally by Finance, by Department HODs, or both? (Draft: both, Finance final.)
2. Should over-budget requests be blocked or only flagged? (Draft: flagged; hard block only at fest total.)
3. Do departments receive cash advances (imprest) that are later settled against receipts? If yes, the reimbursement flow needs a "settle against advance" path. (Draft: out of MVP.)
4. Should in-kind sponsorship be tracked at all, and who estimates its value? (Draft: tracked, excluded from cash.)
5. Event-ticket income: daily totals entered by Finance, or integration with the ticketing platform? (Draft: totals.)
6. Can the Sponsorship department HOD record pledges and receipts, with Finance confirming? (Draft: Finance only.)
7. Is it acceptable for Members to see their department's line items and Available? (Draft: yes, read-only.)
8. Are partial payments ever needed for reimbursements? (Draft: no; vendor milestones cover staged payments.)
9. Who approves a Finance HOD's own reimbursement? (Draft: Management.)
10. How many people hold the Finance HOD and Management roles? Affects the segregation rules.
11. Receipt retention period, and who may bulk-download receipts. (Draft: 2 years; Finance HOD and Management.)
12. Fest dates, number of departments, and last year's transaction volume — to confirm sizing in section 14.
13. Should every department see every department's tickets (full transparency), or only their own incoming and outgoing? (Draft: own only; Management sees all; the fest-wide board optionally read-only for HODs.)
14. Now that the platform is broader than finance, should a separate Fest Admin / Convenor role own platform settings and the fest-wide ticket board instead of Finance HOD?
15. Can a ticket target more than one department? (Draft: no — one per department, linked as related.)
16. Which channel for Urgent tickets on fest days — web push, WhatsApp, or both? Email alone will not work on the ground.
17. Should Management be able to raise tickets? (Draft: yes, as "Core".)
18. Light theme: needed at launch for faculty and college accounts, or v1.1? (Draft: v1.1; exports are light regardless.)
19. Can Design share the vector source of the wordmark and a favicon mark?
20. Should line items need Finance approval before they can receive requests (a hard review gate), or is the optional Reviewed mark plus the document threshold enough? (Draft: no gate.)
21. ~~Is ₹10,000 the right default for the supporting-document threshold?~~ Closed: the default is 0 (off). A missing quotation is Finance's to chase on the budget-review screen, not a refusal aimed at whoever is next to file a claim against the item.

## 18. Technical architecture

Binding for v1. Sections 1–17 describe behavior; this section and the three after it describe how it is built. Where they conflict, fix the later section and keep the behavior.

### 18.1 Stack

| Layer | Choice | Notes |
|---|---|---|
| App | Next.js (App Router, TypeScript). Server Components for reads, Route Handlers under `/app/api/v1` for writes and JSON reads | One deployable on Vercel |
| UI | Tailwind with the 9.1 tokens as the theme, shadcn/ui primitives, lucide-react icons, TanStack Table for data tables | |
| Database | Postgres on Neon. Drizzle ORM; `drizzle-kit` migrations; views from 19.4 applied as a migration | Runs unchanged on Supabase Postgres |
| Auth | Clerk — Google sign-in restricted to the college domain; email invitations for external Management users | Clerk is identity only. Role and department live in our `users` table (synced by Clerk webhook). Authorization is decided in our code |
| Files | Cloudflare R2 (S3-compatible), private bucket. Client uploads with a presigned PUT; reads use signed GET URLs that expire in 15 minutes | Supabase Storage is a drop-in alternative |
| Email | Resend with React Email templates | |
| AI | Anthropic API — a vision-capable model for receipt OCR (8.1) and a text model for F7; JSON output, stored on the attachment | |
| Jobs | Vercel Cron → `/api/v1/cron/*` every 5 minutes (SLA checks, auto-close, reminders) and daily (digest, pledge follow-ups). Protected by `CRON_SECRET`. Idempotent | |
| Live updates | MVP: boards and queues re-fetch every 15 s (SWR `refreshInterval`). v1.1: SSE channel per department | |
| Push | v1.1: Web Push (VAPID) and / or WhatsApp Business API for Urgent tickets | |
| Tests | Vitest for state machines, authorization, and money math; route-handler tests against a Neon branch; Playwright smoke tests for the three core flows | |

### 18.2 Principles the code must follow

1. **One authorization function.** `lib/authz.ts` exports `can(user, action, resource)`. Every route handler calls it before doing anything. The UI uses the same function to hide controls, but hiding is never the enforcement.
2. **State machines in code.** `lib/state-machines/{reimbursement,vendor,ticket}.ts` each export the transition table from 7.2 / 7.3 / 7.7 as data: `{ from, action, to, roles, requires }`. The `transitions` endpoints validate against these tables. They are unit-tested exhaustively (every `from × action` pair).
3. **Derived numbers come from SQL.** The five figures are read from the views in 19.4, never stored, never computed client-side.
4. **Money is integer paise** in the database, the API, and application code. Formatting to ₹ happens only in UI components and exports.
5. **Every write is a service call** in `lib/services/*` that runs in one transaction and writes the audit event in that same transaction. Route handlers contain no business logic.
6. **Segregation of duties (5.2) is enforced in `can`**, not in the UI: the submitter of a record can never be its endorser, approver, or payer.
7. **Soft delete only.** `deleted_at` on records, `removed_at` on attachments. Audit events are append-only (the DB role used by the app has no UPDATE / DELETE on `audit_events`).
8. **Human IDs** — tickets `YUG-142`, reimbursements `RB-0231`, vendor requests `VP-0042` — come from per-fest sequences in `human_id_sequences`, allocated inside the creating transaction.
9. **Idempotency.** Transition and payment-recording endpoints accept an `Idempotency-Key` header; a repeated key returns the original response.
10. **Fest scoping.** A user belongs to exactly one fest; every query is scoped by the caller's `fest_id`. No endpoint takes a fest ID from the client.

### 18.3 Environment variables

```
DATABASE_URL                     # Neon pooled connection string
CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, CLERK_WEBHOOK_SECRET
ALLOWED_EMAIL_DOMAIN             # e.g. sst.scaler.com
R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
ANTHROPIC_API_KEY
RESEND_API_KEY, EMAIL_FROM
CRON_SECRET
APP_URL                          # for links in emails
```

## 19. Database schema

Postgres. UUIDs are generated by the application (UUID v7) with `gen_random_uuid()` as the default. Timestamps are `timestamptz`. All amounts are `bigint` paise.

### 19.1 Enums

```sql
create extension if not exists citext;
create extension if not exists pgcrypto;

create type user_role             as enum ('MEMBER','DEPT_HOD','FINANCE_HOD','MANAGEMENT');
create type user_status           as enum ('INVITED','ACTIVE','DISABLED');
create type department_kind       as enum ('BUDGET','FINANCE','CORE');
create type line_item_status      as enum ('OPEN','CLOSED');
create type reimbursement_status  as enum ('DRAFT','SUBMITTED','SENT_BACK','HOD_ENDORSED','APPROVED','ON_HOLD','PAID','DECLINED','WITHDRAWN');
create type vendor_request_status as enum ('DRAFT','SUBMITTED','SENT_BACK','APPROVED','ADVANCE_PAID','DELIVERED','BALANCE_APPROVED','CLOSED','DECLINED','CANCELLED');
create type milestone_kind        as enum ('ADVANCE','BALANCE','OTHER');
create type income_type           as enum ('SPONSORSHIP_CASH','SPONSORSHIP_IN_KIND','EVENT_TICKETS','COLLEGE_GRANT','OTHER');
create type income_status         as enum ('PLEDGED','PARTIALLY_RECEIVED','RECEIVED','WRITTEN_OFF');
create type ticket_status         as enum ('OPEN','NEEDS_INFO','ACCEPTED','IN_PROGRESS','BLOCKED','DONE','CLOSED','REJECTED','CANCELLED');
create type ticket_priority       as enum ('LOW','MEDIUM','HIGH','URGENT');
create type flag_severity         as enum ('LOW','MEDIUM','HIGH');
create type flag_status           as enum ('OPEN','ACKNOWLEDGED','DISMISSED');
create type entity_type           as enum ('FEST','DEPARTMENT','LINE_ITEM','REIMBURSEMENT','VENDOR','VENDOR_REQUEST','VENDOR_MILESTONE','INCOME_ENTRY','BUDGET_TRANSFER','TICKET','USER','ATTACHMENT','COMMENT','FLAG');
create type attachment_purpose    as enum ('RECEIPT','QUOTE','LISTING','PO','INVOICE','DELIVERY_PROOF','PAYMENT_PROOF','MOU','TICKET_ATTACHMENT','TICKET_PROOF','OTHER','CHAT_ATTACHMENT','CLAIM_PAYMENT_PROOF');
create type attachment_kind       as enum ('FILE','LINK');
create type notification_channel  as enum ('IN_APP','EMAIL','PUSH','WHATSAPP');
```

### 19.2 Tables

Departments of kind `FINANCE` and `CORE` exist so that tickets can be addressed to Finance and raised by Management ("Core") with no special cases: Finance HODs belong to the Finance department, Management users to Core. Neither holds a budget unless Finance chooses to allocate one.

```sql
create table fests (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  slug                 text not null unique,
  starts_on            date not null,
  ends_on              date not null,
  receipt_window_start date not null,
  receipt_window_end   date not null,
  total_budget_paise   bigint not null default 0 check (total_budget_paise >= 0),
  currency             char(3) not null default 'INR',
  settings             jsonb not null default '{}',   -- shape in 19.5
  is_active            boolean not null default true,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table departments (
  id               uuid primary key default gen_random_uuid(),
  fest_id          uuid not null references fests(id),
  name             text not null,
  slug             text not null,
  kind             department_kind not null default 'BUDGET',
  allocated_paise  bigint not null default 0 check (allocated_paise >= 0),
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (fest_id, slug)
);
create unique index departments_one_finance on departments (fest_id) where kind = 'FINANCE';
create unique index departments_one_core    on departments (fest_id) where kind = 'CORE';

create table users (
  id             uuid primary key default gen_random_uuid(),
  fest_id        uuid not null references fests(id),
  clerk_user_id  text unique,
  email          citext not null,
  name           text not null,
  role           user_role not null,
  department_id  uuid not null references departments(id),
  upi_id         text,
  phone          text,
  status         user_status not null default 'INVITED',
  digest_opt_in  boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (fest_id, email)
);
-- Service layer enforces: FINANCE_HOD users belong to the FINANCE department; MANAGEMENT users to CORE.

create table expense_types (
  id          uuid primary key default gen_random_uuid(),
  fest_id     uuid not null references fests(id),
  name        text not null,
  sort_order  int not null default 0,
  is_active   boolean not null default true,
  unique (fest_id, name)
);

create table line_items (
  id                      uuid primary key default gen_random_uuid(),
  fest_id                 uuid not null references fests(id),
  department_id           uuid not null references departments(id),
  name                    text not null,
  description             text,
  planned_paise           bigint not null check (planned_paise >= 0),
  default_expense_type_id uuid references expense_types(id),
  status                  line_item_status not null default 'OPEN',
  closed_at               timestamptz,
  closed_by               uuid references users(id),
  close_reason            text,
  reviewed_at             timestamptz,
  reviewed_by             uuid references users(id),
  created_by              uuid not null references users(id),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  deleted_at              timestamptz
);
-- Service layer enforces, with SELECT ... FOR UPDATE on the department row:
--   sum(planned_paise of open + closed, not deleted) <= departments.allocated_paise
--   planned_paise >= committed + spent for that line item (19.4) on any decrease

create table attachments (                       -- files and links on any entity
  id                   uuid primary key default gen_random_uuid(),
  fest_id              uuid not null references fests(id),
  entity_type          entity_type,              -- null until bound (upload-then-create flow, 20.2)
  entity_id            uuid,
  purpose              attachment_purpose not null,
  kind                 attachment_kind not null,
  storage_key          text,                     -- FILE: R2 object key
  url                  text,                     -- LINK: external URL
  file_name            text,
  mime_type            text,
  size_bytes           bigint,
  sha256               text,                     -- F1 exact duplicate
  phash                text,                     -- F1 perceptual duplicate (images)
  label                text,                     -- "Quotation — ABC Sound", "Amazon listing"
  source_name          text,                     -- vendor or site
  quoted_amount_paise  bigint,                   -- QUOTE / LISTING on line items
  ocr_json             jsonb,                    -- 8.1 output for RECEIPT / INVOICE
  uploaded_by          uuid not null references users(id),
  created_at           timestamptz not null default now(),
  removed_at           timestamptz,
  removed_by           uuid references users(id),
  check ((kind = 'FILE' and storage_key is not null) or (kind = 'LINK' and url is not null))
);

create table reimbursement_requests (
  id                 uuid primary key default gen_random_uuid(),
  fest_id            uuid not null references fests(id),
  human_id           text not null,               -- RB-0231
  department_id      uuid not null references departments(id),
  line_item_id       uuid not null references line_items(id),
  expense_type_id    uuid not null references expense_types(id),
  submitter_id       uuid not null references users(id),
  description        text not null check (char_length(description) >= 10),
  transaction_on     date not null,
  amount_paise       bigint not null check (amount_paise > 0),
  merchant           text,
  payee_name         text not null,
  payee_upi_id       text not null,
  status             reimbursement_status not null default 'DRAFT',
  version            int not null default 1,
  submitted_at       timestamptz,
  endorsed_by        uuid references users(id),
  endorsed_at        timestamptz,
  approved_by        uuid references users(id),
  approved_at        timestamptz,
  approval_note      text,                        -- required when approving over an open High flag
  paid_by            uuid references users(id),
  paid_at            timestamptz,
  payment_reference  text,
  last_reason        text,                        -- reason of the latest send-back / decline / hold
  send_back_count    int not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  unique (fest_id, human_id)
);

create table vendors (
  id                   uuid primary key default gen_random_uuid(),
  fest_id              uuid not null references fests(id),
  name                 text not null,
  contact_name         text,
  phone                text,
  email                citext,
  bank_account_name    text,
  bank_account_number  text,                      -- shown in full only to FINANCE_HOD and MANAGEMENT; masked elsewhere
  bank_ifsc            text,
  upi_id               text,
  gstin                text,
  notes                text,
  created_by           uuid not null references users(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz,
  unique (fest_id, name)
);

create table vendor_requests (
  id                     uuid primary key default gen_random_uuid(),
  fest_id                uuid not null references fests(id),
  human_id               text not null,             -- VP-0042
  department_id          uuid not null references departments(id),
  line_item_id           uuid not null references line_items(id),
  vendor_id              uuid not null references vendors(id),
  description            text not null,
  total_value_paise      bigint not null check (total_value_paise > 0),
  approved_value_paise   bigint,                    -- set on APPROVE; may be reduced on RELEASE_BALANCE
  expected_delivery_on   date,
  status                 vendor_request_status not null default 'DRAFT',
  requested_by           uuid not null references users(id),
  approved_by            uuid references users(id),
  approved_at            timestamptz,
  delivered_at           timestamptz,
  delivery_note          text,
  delivery_confirmed_by  uuid references users(id),
  balance_approved_by    uuid references users(id),
  balance_approved_at    timestamptz,
  balance_adjust_reason  text,
  refund_expected_paise  bigint not null default 0,
  refund_received_paise  bigint not null default 0,
  refund_received_at     timestamptz,
  last_reason            text,
  closed_at              timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  deleted_at             timestamptz,
  unique (fest_id, human_id)
);

create table vendor_milestones (
  id                 uuid primary key default gen_random_uuid(),
  vendor_request_id  uuid not null references vendor_requests(id),
  kind               milestone_kind not null,
  sort_order         int not null default 0,
  planned_paise      bigint not null check (planned_paise >= 0),
  paid_paise         bigint,
  paid_at            timestamptz,
  paid_by            uuid references users(id),
  payment_reference  text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
-- Service layer enforces: sum(planned_paise) = coalesce(approved_value_paise, total_value_paise).
-- MVP creates exactly two milestones (ADVANCE, BALANCE); the model allows more.

create table income_entries (
  id                    uuid primary key default gen_random_uuid(),
  fest_id               uuid not null references fests(id),
  type                  income_type not null,
  source_name           text not null,
  owning_department_id  uuid references departments(id),
  pledged_paise         bigint not null default 0 check (pledged_paise >= 0),
  pledged_on            date,
  status                income_status not null default 'PLEDGED',
  written_off_reason    text,
  notes                 text,
  created_by            uuid not null references users(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz
);

create table income_tranches (
  id               uuid primary key default gen_random_uuid(),
  income_entry_id  uuid not null references income_entries(id),
  amount_paise     bigint not null check (amount_paise > 0),
  received_on      date not null,
  reference        text,
  recorded_by      uuid not null references users(id),
  created_at       timestamptz not null default now()
);

create table budget_transfers (                 -- history; departments.allocated_paise is the current value
  id                  uuid primary key default gen_random_uuid(),
  fest_id             uuid not null references fests(id),
  from_department_id  uuid references departments(id),   -- null = reserve
  to_department_id    uuid references departments(id),   -- null = reserve
  amount_paise        bigint not null check (amount_paise > 0),
  reason              text not null,
  created_by          uuid not null references users(id),
  created_at          timestamptz not null default now(),
  check (from_department_id is distinct from to_department_id)
);

create table tickets (
  id                       uuid primary key default gen_random_uuid(),
  fest_id                  uuid not null references fests(id),
  human_id                 text not null,           -- YUG-142
  title                    text not null check (char_length(title) <= 80),
  description              text not null,
  requesting_department_id uuid not null references departments(id),
  requester_id             uuid not null references users(id),
  target_department_id     uuid not null references departments(id),
  assignee_id              uuid references users(id),
  priority                 ticket_priority not null default 'MEDIUM',
  due_at                   timestamptz not null,
  location                 text,
  estimated_cost_paise     bigint,
  line_item_id             uuid references line_items(id),
  status                   ticket_status not null default 'OPEN',
  previous_status          ticket_status,           -- restored when NEEDS_INFO is answered
  info_request             text,
  blocked_reason           text,
  reject_reason            text,
  escalated_at             timestamptz,
  escalated_by             uuid references users(id),
  triage_reminded_at       timestamptz,
  done_reminded_at         timestamptz,
  triaged_at               timestamptz,
  started_at               timestamptz,
  done_at                  timestamptz,
  closed_at                timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  deleted_at               timestamptz,
  unique (fest_id, human_id),
  check (requesting_department_id <> target_department_id)
);

create table ticket_watchers (
  ticket_id  uuid not null references tickets(id),
  user_id    uuid not null references users(id),
  primary key (ticket_id, user_id)
);

create table ticket_templates (                 -- v1.1
  id                    uuid primary key default gen_random_uuid(),
  fest_id               uuid not null references fests(id),
  name                  text not null,
  target_department_id  uuid references departments(id),
  default_priority      ticket_priority not null default 'MEDIUM',
  fields                jsonb not null default '[]',   -- [{key,label,type,required}]
  is_active             boolean not null default true
);

create table entity_links (                    -- ticket ↔ reimbursement / vendor request / ticket
  id          uuid primary key default gen_random_uuid(),
  fest_id     uuid not null references fests(id),
  from_type   entity_type not null,
  from_id     uuid not null,
  to_type     entity_type not null,
  to_id       uuid not null,
  relation    text not null default 'RELATED',
  created_by  uuid not null references users(id),
  created_at  timestamptz not null default now(),
  unique (from_type, from_id, to_type, to_id)
);

create table comments (
  id           uuid primary key default gen_random_uuid(),
  fest_id      uuid not null references fests(id),
  entity_type  entity_type not null,
  entity_id    uuid not null,
  author_id    uuid not null references users(id),
  body         text not null,
  created_at   timestamptz not null default now(),
  edited_at    timestamptz
);

create table comment_mentions (
  comment_id  uuid not null references comments(id),
  user_id     uuid not null references users(id),
  primary key (comment_id, user_id)
);

create table audit_events (                    -- append-only
  id           uuid primary key default gen_random_uuid(),
  fest_id      uuid not null references fests(id),
  entity_type  entity_type not null,
  entity_id    uuid not null,
  actor_id     uuid references users(id),      -- null = system / cron
  action       text not null,                  -- e.g. 'reimbursement.transition.APPROVE', 'line_item.document.add'
  before       jsonb,
  after        jsonb,
  reason       text,
  created_at   timestamptz not null default now()
);

create table flags (
  id               uuid primary key default gen_random_uuid(),
  fest_id          uuid not null references fests(id),
  entity_type      entity_type not null,
  entity_id        uuid not null,
  rule             text not null,              -- 'F1' … 'F14'
  severity         flag_severity not null,
  explanation      text not null,
  status           flag_status not null default 'OPEN',
  resolved_by      uuid references users(id),
  resolved_at      timestamptz,
  resolution_note  text,
  created_at       timestamptz not null default now()
);

create table notifications (
  id            uuid primary key default gen_random_uuid(),
  fest_id       uuid not null references fests(id),
  recipient_id  uuid not null references users(id),
  type          text not null,                 -- row keys of the section 10 table, e.g. 'ticket.raised'
  entity_type   entity_type,
  entity_id     uuid,
  title         text not null,
  body          text,
  channel       notification_channel not null default 'IN_APP',
  sent_at       timestamptz,
  read_at       timestamptz,
  created_at    timestamptz not null default now()
);

create table human_id_sequences (
  fest_id     uuid not null references fests(id),
  prefix      text not null,                   -- 'RB', 'VP', 'YUG'
  last_value  int not null default 0,
  primary key (fest_id, prefix)
);

create table idempotency_keys (
  key           text primary key,
  user_id       uuid not null references users(id),
  response      jsonb not null,
  created_at    timestamptz not null default now()
);
```

### 19.3 Indexes

```sql
create index on users (fest_id, role, department_id);
create index on line_items (department_id) where deleted_at is null;
create index on attachments (entity_type, entity_id) where removed_at is null;
create index on attachments (fest_id, sha256) where sha256 is not null;
create index on attachments (fest_id, phash)  where phash  is not null;
create index on reimbursement_requests (fest_id, status);
create index on reimbursement_requests (department_id, status);
create index on reimbursement_requests (line_item_id);
create index on reimbursement_requests (submitter_id);
create index on reimbursement_requests (fest_id, payee_upi_id);            -- F6
create index on reimbursement_requests (fest_id, amount_paise, transaction_on, merchant);  -- F1
create index on vendor_requests (fest_id, status);
create index on vendor_requests (vendor_id);
create index on vendor_requests (line_item_id);
create index on vendor_milestones (vendor_request_id);
create index on income_tranches (income_entry_id);
create index on tickets (target_department_id, status, priority, due_at);
create index on tickets (requesting_department_id, status);
create index on tickets (assignee_id, status);
create index on comments (entity_type, entity_id, created_at);
create index on audit_events (entity_type, entity_id, created_at);
create index on audit_events (fest_id, created_at);
create unique index flags_one_open_per_rule on flags (entity_type, entity_id, rule) where status = 'OPEN';
create index on notifications (recipient_id, read_at, created_at desc);
```

### 19.4 Views — the budget arithmetic

These are the normative definition of the five numbers (6.2) and the fest roll-up (6.3). Status → bucket mapping:

| Bucket | Reimbursements | Vendor requests |
|---|---|---|
| Pending | SUBMITTED, HOD_ENDORSED | SUBMITTED (total value) |
| Committed | APPROVED, ON_HOLD | APPROVED, ADVANCE_PAID, DELIVERED, BALANCE_APPROVED: approved value − paid milestones |
| Spent | PAID | Paid milestones − refund received, in any state after approval (including CLOSED, CANCELLED) |

```sql
create view v_line_item_totals as
with r as (
  select line_item_id,
         coalesce(sum(amount_paise) filter (where status in ('SUBMITTED','HOD_ENDORSED')), 0) as pending,
         coalesce(sum(amount_paise) filter (where status in ('APPROVED','ON_HOLD')), 0)      as committed,
         coalesce(sum(amount_paise) filter (where status = 'PAID'), 0)                        as spent
  from reimbursement_requests
  where deleted_at is null
  group by line_item_id
),
paid as (
  select vendor_request_id, coalesce(sum(paid_paise), 0) as paid
  from vendor_milestones group by vendor_request_id
),
v as (
  select vr.line_item_id,
         coalesce(sum(vr.total_value_paise) filter (where vr.status = 'SUBMITTED'), 0) as pending,
         coalesce(sum(greatest(coalesce(vr.approved_value_paise, vr.total_value_paise) - coalesce(p.paid, 0), 0))
           filter (where vr.status in ('APPROVED','ADVANCE_PAID','DELIVERED','BALANCE_APPROVED')), 0) as committed,
         coalesce(sum(coalesce(p.paid, 0) - vr.refund_received_paise)
           filter (where vr.status in ('APPROVED','ADVANCE_PAID','DELIVERED','BALANCE_APPROVED','CLOSED','CANCELLED')), 0) as spent
  from vendor_requests vr
  left join paid p on p.vendor_request_id = vr.id
  where vr.deleted_at is null
  group by vr.line_item_id
)
select li.id            as line_item_id,
       li.fest_id,
       li.department_id,
       li.status,
       li.planned_paise,
       coalesce(r.pending, 0)   + coalesce(v.pending, 0)   as pending_paise,
       coalesce(r.committed, 0) + coalesce(v.committed, 0) as committed_paise,
       coalesce(r.spent, 0)     + coalesce(v.spent, 0)     as spent_paise,
       li.planned_paise
         - coalesce(r.pending, 0)   - coalesce(v.pending, 0)
         - coalesce(r.committed, 0) - coalesce(v.committed, 0)
         - coalesce(r.spent, 0)     - coalesce(v.spent, 0)   as available_paise
from line_items li
left join r on r.line_item_id = li.id
left join v on v.line_item_id = li.id
where li.deleted_at is null;

create view v_department_totals as
select d.id                                   as department_id,
       d.fest_id,
       d.kind,
       d.allocated_paise,
       coalesce(sum(t.planned_paise), 0)      as planned_paise,
       coalesce(sum(t.pending_paise), 0)      as pending_paise,
       coalesce(sum(t.committed_paise), 0)    as committed_paise,
       coalesce(sum(t.spent_paise), 0)        as spent_paise,
       d.allocated_paise
         - coalesce(sum(t.pending_paise), 0)
         - coalesce(sum(t.committed_paise), 0)
         - coalesce(sum(t.spent_paise), 0)    as available_paise
from departments d
left join v_line_item_totals t on t.department_id = d.id
where d.is_active
group by d.id;

create view v_income_totals as
with tr as (
  select income_entry_id, coalesce(sum(amount_paise), 0) as received
  from income_tranches group by income_entry_id
)
select i.fest_id,
       i.type,
       coalesce(sum(i.pledged_paise) filter (where i.status <> 'WRITTEN_OFF'), 0)                 as pledged_paise,
       coalesce(sum(tr.received), 0)                                                               as received_paise,
       coalesce(sum(greatest(i.pledged_paise, coalesce(tr.received, 0)))
         filter (where i.status <> 'WRITTEN_OFF'), 0)                                              as expected_paise
from income_entries i
left join tr on tr.income_entry_id = i.id
where i.deleted_at is null
group by i.fest_id, i.type;

create view v_fest_totals as
select f.id                                                   as fest_id,
       f.total_budget_paise,
       coalesce(sum(d.allocated_paise), 0)                    as allocated_paise,
       f.total_budget_paise - coalesce(sum(d.allocated_paise), 0) as reserve_paise,
       coalesce(sum(d.pending_paise), 0)                      as pending_paise,
       coalesce(sum(d.committed_paise), 0)                    as committed_paise,
       coalesce(sum(d.spent_paise), 0)                        as spent_paise,
       cash.received_paise                                    as income_received_paise,
       cash.pledged_paise                                     as income_pledged_paise,
       cash.expected_paise                                    as income_expected_paise,
       cash.received_paise - coalesce(sum(d.spent_paise), 0)  as cash_position_paise,
       cash.expected_paise
         - coalesce(sum(d.spent_paise), 0)
         - coalesce(sum(d.committed_paise), 0)
         - coalesce(sum(d.pending_paise), 0)                  as projected_close_paise
from fests f
left join v_department_totals d on d.fest_id = f.id
left join lateral (
  select coalesce(sum(received_paise), 0) as received_paise,
         coalesce(sum(pledged_paise), 0)  as pledged_paise,
         coalesce(sum(expected_paise), 0) as expected_paise
  from v_income_totals it
  where it.fest_id = f.id and it.type <> 'SPONSORSHIP_IN_KIND'       -- in-kind never counts toward cash
) cash on true
group by f.id, cash.received_paise, cash.pledged_paise, cash.expected_paise;
```

### 19.5 `fests.settings` shape

```json
{
  "fest_days": ["2026-11-27", "2026-11-28", "2026-11-29"],
  "line_item_doc_threshold_paise": 0,
  "request_aging_amber_days": 3,
  "request_aging_red_days": 7,
  "ticket_auto_close_hours": 48,
  "ticket_done_reminder_hours": 24,
  "ticket_sla_minutes": {
    "URGENT": { "fest": 30,   "other": 120  },
    "HIGH":   { "fest": 120,  "other": 480  },
    "MEDIUM": { "fest": 1440, "other": 1440 },
    "LOW":    { "fest": 4320, "other": 4320 }
  },
  "flag_thresholds": {
    "F2_abs_paise": 5000, "F2_pct": 5,
    "F4_before_days": 60, "F4_after_days": 15,
    "F6_count": 5, "F6_total_paise": 2500000,
    "F8_pct": 50, "F10_threshold_paise": 1000000,
    "F11_multiplier": 3, "F11_min_samples": 10,
    "F14_pct": 20,
    "income_followup_days": 30
  }
}
```

### 19.6 Verification fixture

The DDL and views above load cleanly on Postgres 16. This scenario was run against them and is the fixture for the 21.3 arithmetic test.

One department (Tech, allocated ₹1,00,000) with one line item (Sound, planned ₹60,000). Amounts in rupees.

| Input | Detail |
|---|---|
| Reimbursements on Sound | SUBMITTED 1,000 · HOD_ENDORSED 2,000 · APPROVED 3,000 · ON_HOLD 500 · PAID 4,000 · DECLINED 999 · SENT_BACK 777 · DRAFT 111 |
| Vendor request VP-1 | ADVANCE_PAID, approved 20,000; advance 10,000 paid, balance 10,000 unpaid |
| Vendor request VP-2 | SUBMITTED, total 5,000 |
| Vendor request VP-3 | CANCELLED, advance 2,000 paid, refund received 500 |
| Income | Sponsorship cash pledged 30,000 / received 10,000 · in-kind pledged 5,000 · event tickets received 2,000 · written-off pledge 4,000 |

| Expected | Value |
|---|---|
| Sound — pending / committed / spent / available | 8,000 / 13,500 / 15,500 / 23,000 |
| Tech — planned / available | 60,000 / 63,000 |
| Fest — income received / pledged / expected | 12,000 / 30,000 / 32,000 |
| Fest — cash position / projected close | −3,500 / −5,000 |

## 20. API

### 20.1 Conventions

- Base path `/api/v1`. JSON in and out. All routes require a Clerk session except `/webhooks/*` and `/cron/*`.
- The caller's `fest_id`, role, and department come from the session; no endpoint accepts a fest ID.
- Money fields are integer paise and end in `_paise`. Dates are `YYYY-MM-DD`; timestamps are ISO 8601 UTC.
- List endpoints: `?limit=50&cursor=…` plus resource-specific filters; response `{ "data": [...], "next_cursor": "…" | null }`.
- Errors: `{ "error": { "code": "VALIDATION_ERROR" | "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "INVALID_TRANSITION" | "CONFLICT" | "OVER_ALLOCATION" | "RATE_LIMITED", "message": "…", "details": {…} } }` with 400 / 401 / 403 / 404 / 409 / 422 / 429.
- Single-resource GETs return the record plus `attachments`, `flags`, `comments`, `timeline` (audit events) and `links`, so detail screens need one call.
- State changes go through `POST /{resource}/{id}/transitions` with `{ "action": "…", "reason"?: "…", …extra }`. The server checks role, state machine, segregation of duties, and required fields; writes the audit event; evaluates flags; queues notifications; returns the updated resource. `Idempotency-Key` header supported.
- Role column: **M** Member, **H** Dept HOD, **F** Finance HOD, **Mg** Management. "own" = own department (H) or own record (M).

### 20.2 Attachments — upload flow

1. `POST /attachments/presign` with `{ purpose, file_name, mime_type, size_bytes, entity_type?, entity_id? }` → `{ attachment_id, upload_url, storage_key }`. Validates type and size against section 14.
2. Client `PUT`s the file to `upload_url`.
3. `POST /attachments/{id}/complete` → server verifies the object exists, computes `sha256` (and `phash` for images), and for `RECEIPT` / `INVOICE` starts OCR. Returns the attachment with `ocr_json` when ready (poll `GET /attachments/{id}`).
4. If the parent record does not exist yet, the create endpoint accepts `attachment_ids: [...]` and binds attachments uploaded by the same user. Unbound attachments older than 24 h are garbage-collected.
5. Links (`kind: LINK`) skip steps 1–3: `POST /attachments` with `{ kind: "LINK", purpose, url, label, source_name, quoted_amount_paise?, entity_type, entity_id }`.

| Method | Path | Roles | Purpose |
|---|---|---|---|
| POST | `/attachments/presign` | all | Step 1 |
| POST | `/attachments/{id}/complete` | uploader | Step 3 |
| POST | `/attachments` | all | Create a LINK attachment |
| GET | `/attachments/{id}` | anyone who can see the parent | Metadata + `ocr_json` |
| GET | `/attachments/{id}/url` | anyone who can see the parent | Signed GET URL, 15 min |
| GET | `/bills/{id}?sig=` | anyone holding the link; no session | Bill link from the reimbursement export (section 11). 302 to a signed GET URL, 15 min |
| DELETE | `/attachments/{id}` | uploader while parent is editable; H/F for line-item documents | Soft remove |

### 20.3 Me, users, webhooks

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/me` | all | Current user, role, department, fest, and the `can` summary for the UI |
| PATCH | `/me` | all | `upi_id`, `phone`, `digest_opt_in` |
| GET | `/users` | F, Mg | List with filters `role`, `department_id`, `status` |
| POST | `/users` | F | Invite: `{ email, name, role, department_id }` → creates INVITED user and sends a Clerk invitation |
| PATCH | `/users/{id}` | F | Change `role`, `department_id`, `status`; logged |
| POST | `/webhooks/clerk` | Clerk (signature) | `user.created` / `user.updated`: link `clerk_user_id` to the INVITED user with that email (domain-checked); unknown emails are rejected |

### 20.4 Fest, settings, expense types, departments, transfers

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/fest` | all | Fest record; `settings` included for F only |
| PATCH | `/fest` | F | Dates, receipt window, `total_budget_paise` (cannot go below Σ allocations), `settings` |
| GET | `/expense-types` | all | Active types |
| POST | `/expense-types` · PATCH `/expense-types/{id}` | F | Manage; deactivate rather than delete |
| GET | `/departments` | all | Names, kinds, HODs. Budget figures included only for departments the caller may see |
| POST | `/departments` · PATCH `/departments/{id}` | F | Create / rename / deactivate; `allocated_paise` is changed only through transfers |
| GET | `/departments/{id}/summary` | own H, F, Mg; M sees own dept (line items + available only) | `v_department_totals` row + line items with `v_line_item_totals` + documents |
| GET | `/budget-transfers` | F, Mg; H sees own | History |
| POST | `/budget-transfers` | F | `{ from_department_id | null, to_department_id | null, amount_paise, reason }`. Fails with `OVER_ALLOCATION` if source would drop below committed + spent or reserve would go negative |

### 20.5 Line items and supporting documents

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/departments/{id}/line-items` | own M/H, F, Mg | With totals and document counts; `?include=documents` |
| POST | `/departments/{id}/line-items` | own H, F | `{ name, description?, planned_paise, default_expense_type_id?, attachment_ids? }`. `OVER_ALLOCATION` if Σ would exceed the department allocation |
| GET | `/line-items/{id}` | as above | Totals, documents (with quoted amounts and lowest quote), attached requests, flags, timeline |
| PATCH | `/line-items/{id}` | own H, F | Name, description, planned amount (cannot go below committed + spent), expense type |
| DELETE | `/line-items/{id}` | own H, F | Soft delete, logged, optional `?reason=`. `CONFLICT` while any reimbursement or vendor request is charged against it, whatever its state — close it instead (7.5) |
| POST | `/line-items/{id}/transitions` | own H, F (`MARK_REVIEWED`: F only) | Actions: `CLOSE` (reason), `REOPEN` (reason), `MARK_REVIEWED`, `UNMARK_REVIEWED` |
| GET | `/line-items/{id}/documents` | as GET | Supporting documents, removed ones excluded unless `?include_removed=1` (F) |
| POST | `/line-items/{id}/documents` | own H, F | Bind an uploaded file `{ attachment_id, label, source_name, quoted_amount_paise? }` or create a link `{ kind: "LINK", url, label, source_name, quoted_amount_paise?, screenshot_attachment_id? }`. Max 10 active. Re-evaluates F13 / F14 |
| PATCH | `/line-items/{id}/documents/{attachment_id}` | own H, F | Edit label, source, quoted amount |
| DELETE | `/line-items/{id}/documents/{attachment_id}` | own H, F | Soft remove; logged; re-evaluates F13 / F14 |
| GET | `/budget-review` | F | All line items across departments, unreviewed-above-threshold first, with lowest quote vs planned |

### 20.6 Reimbursements

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/reimbursements` | M own; H own dept; F, Mg all | Filters: `status`, `department_id`, `line_item_id`, `submitter_id`, `flagged=1`, `from`, `to`, `q` |
| POST | `/reimbursements` | all | Creates DRAFT, or SUBMITTED when `submit: true`. Body: `line_item_id, expense_type_id, description, transaction_on, amount_paise, merchant?, payee_name, payee_upi_id, attachment_ids[], payment_proof_ids[]` (≥ 1 receipt, ≥ 1 proof of payment) |
| GET | `/reimbursements/{id}` | as list | Full record (20.1) |
| PATCH | `/reimbursements/{id}` | submitter, in DRAFT / SENT_BACK | Any field; bumps `version`; old attachments stay, removed ones soft-removed |
| POST | `/reimbursements/{id}/transitions` | see table below | State change |
| POST | `/reimbursements/bulk-approve` | F | `{ ids[] }` → approves those without open High flags; returns per-id result |

Transition actions (7.2):

| Action | From | Who | Body |
|---|---|---|---|
| `SUBMIT` | DRAFT | submitter | — (HOD submitter lands in HOD_ENDORSED) |
| `ENDORSE` | SUBMITTED | target dept H (F override, logged) | — |
| `SEND_BACK` | SUBMITTED, HOD_ENDORSED | H / F | `reason` |
| `DECLINE` | SUBMITTED, HOD_ENDORSED, ON_HOLD | H / F | `reason` |
| `RESUBMIT` | SENT_BACK | submitter | — (→ SUBMITTED, or HOD_ENDORSED for an HOD submitter) |
| `APPROVE` | HOD_ENDORSED | F (Mg when submitter is F) | `approval_note` required if an open High flag exists |
| `HOLD` | APPROVED | Mg | `reason` |
| `RESOLVE_HOLD` | ON_HOLD | F | `note` |
| `RECORD_PAYMENT` | APPROVED | Mg (not the submitter) | `payment_reference, paid_at, proof_attachment_id?` |
| `WITHDRAW` | any non-terminal | submitter | — |

### 20.7 Vendors and vendor requests

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/vendors` · GET `/vendors/{id}` | H, F, Mg | `{id}` includes exposure: contracted, paid, outstanding, refunds. Bank fields masked for H |
| POST | `/vendors` · PATCH `/vendors/{id}` | H, F | Create / edit (edits to bank details are logged with before / after masked) |
| GET | `/vendor-requests` | H own dept; F, Mg all | Filters: `status`, `department_id`, `vendor_id`, `overdue=1` |
| POST | `/vendor-requests` | H, F | `vendor_id | vendor: {…}`, `line_item_id, description, total_value_paise, milestones: [{ kind, planned_paise }], expected_delivery_on, attachment_ids[]` (quote / PO). `submit: true` to submit directly |
| GET | `/vendor-requests/{id}` | as list | Full record with milestones |
| PATCH | `/vendor-requests/{id}` | requester, in DRAFT / SENT_BACK | Any field including milestones |
| POST | `/vendor-requests/{id}/transitions` | see table | State change |

Transition actions (7.3):

| Action | From | Who | Body |
|---|---|---|---|
| `SUBMIT` | DRAFT | requester | — |
| `APPROVE` | SUBMITTED | F | `approved_value_paise?` (defaults to total) |
| `SEND_BACK` / `DECLINE` | SUBMITTED | F | `reason` |
| `RESUBMIT` | SENT_BACK | requester | — |
| `RECORD_ADVANCE` | APPROVED | Mg | `milestone_id, paid_paise, paid_at, payment_reference, proof_attachment_id?` |
| `CONFIRM_DELIVERY` | APPROVED (advance = 0), ADVANCE_PAID | target dept H, F | `delivered_at, note?, invoice_attachment_id` (required) |
| `RELEASE_BALANCE` | DELIVERED | F | `approved_value_paise?` (≤ current), `reason` if changed |
| `RECORD_BALANCE` | BALANCE_APPROVED | Mg | `milestone_id, paid_paise, paid_at, payment_reference, proof_attachment_id?` → CLOSED |
| `CLOSE` | DELIVERED (balance = 0) | F | — |
| `CANCEL` | APPROVED, ADVANCE_PAID | F | `reason, refund_expected_paise?` |
| `RECORD_REFUND` | CANCELLED | Mg | `amount_paise, received_at, reference` |

### 20.8 Income

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/income` | F, Mg | Filters: `type`, `status`, `owning_department_id`, `overdue=1` (pledged > `income_followup_days`) |
| GET | `/income/summary` | F, Mg | `v_income_totals` by type plus fest cash position |
| POST | `/income` · PATCH `/income/{id}` | F | Entry fields; `attachment_ids[]` for MoU / invoice |
| POST | `/income/{id}/tranches` | F | `{ amount_paise, received_on, reference }`; updates status to PARTIALLY_RECEIVED / RECEIVED |
| POST | `/income/{id}/transitions` | F | `WRITE_OFF` (reason), `REINSTATE` |
| GET | `/income/{id}/statement` | F, Mg | Sponsor-wise statement (JSON; PDF via exports) |

### 20.9 Work tickets

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/tickets` | all, scoped | `view=inbox` (target = my dept), `outgoing`, `mine` (assigned to me), `raised` (by me), `all` (Mg; H if open question 13 allows). Filters: `status`, `priority`, `department_id`, `assignee_id`, `overdue=1`, `escalated=1`, `q` |
| POST | `/tickets` | all | `{ title, description, target_department_id, priority?, due_at, location?, estimated_cost_paise?, line_item_id?, attachment_ids?, template_id? }` |
| GET | `/tickets/{id}` | both departments, Mg | Full record with watchers, links, timeline |
| PATCH | `/tickets/{id}` | requester (OPEN, NEEDS_INFO); target H (priority, due_at, assignee_id, location) | Edits are logged; due / priority changes notify the requester |
| POST | `/tickets/{id}/transitions` | see table | State change |
| POST / DELETE | `/tickets/{id}/watchers/{user_id}` | self, or target H | Watch / unwatch |
| POST | `/tickets/{id}/links` | both departments | `{ to_type, to_id }` — reimbursement, vendor request, ticket |
| GET | `/tickets/similar?target_department_id=&title=` | all | Up to 5 open tickets with similar titles (trigram similarity) |
| GET | `/tickets/workload` | Mg; H own dept | Counts by department × priority × status, plus overdue and escalated counts |
| GET / POST / PATCH | `/ticket-templates` | all read; F write | v1.1 |

Transition actions (7.7):

| Action | From | Who | Body |
|---|---|---|---|
| `ACCEPT` | OPEN | target H | `assignee_id?, priority?, due_at?` |
| `ASK_INFO` | OPEN, ACCEPTED, IN_PROGRESS | target H, assignee | `question` |
| `REPLY_INFO` | NEEDS_INFO | requester | `answer` (→ `previous_status`) |
| `REJECT` | OPEN | target H | `reason` |
| `START` | ACCEPTED | assignee | — |
| `BLOCK` | IN_PROGRESS | assignee | `reason` |
| `UNBLOCK` | BLOCKED | assignee, target H | — |
| `MARK_DONE` | ACCEPTED, IN_PROGRESS | assignee, target H | `note?, proof_attachment_id?` |
| `CONFIRM` | DONE | requester, requesting H | — |
| `REOPEN` | DONE | requester, requesting H | `reason` |
| `REASSIGN` | ACCEPTED, IN_PROGRESS, BLOCKED | target H | `assignee_id` |
| `CANCEL` | any non-terminal | requester, requesting H | — |
| `ESCALATE` | OPEN (past SLA), BLOCKED, REJECTED | requester, either H | `note?` — sets `escalated_at`, state unchanged |

### 20.10 Comments, flags, audit, notifications

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/comments?entity_type=&entity_id=` | anyone who can see the entity | Chronological |
| POST | `/comments` | same | `{ entity_type, entity_id, body, mention_user_ids[] }` — mentions must be users who can see the entity |
| PATCH | `/comments/{id}` | author, within 5 min | Sets `edited_at` |
| GET | `/flags` | F all; H own dept | `status=OPEN` default; sorted severity, age |
| POST | `/flags/{id}/transitions` | F | `ACKNOWLEDGE` (note), `DISMISS` (reason) |
| POST | `/flags/evaluate` | F | `{ entity_type, entity_id }` — re-run rules |
| GET | `/audit?entity_type=&entity_id=` | anyone who can see the entity | Timeline |
| GET | `/audit?from=&to=&actor_id=&action=` | F, Mg; H own dept | Fest-wide log |
| GET | `/notifications` · POST `/notifications/{id}/read` · POST `/notifications/read-all` | self | In-app inbox |

### 20.11 Dashboards and queues

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/dashboard/fest` | F, Mg | `v_fest_totals`, income by type, department table (`v_department_totals`), open flags count, queue counts, overdue vendors, escalated tickets |
| GET | `/dashboard/department/{id}` | own M/H, F, Mg | Department totals, line items with totals, recent activity, ticket counts |
| GET | `/dashboard/me` | all | My requests by status, my tickets, unread notifications |
| GET | `/queues/endorsements` | H | SUBMITTED reimbursements for my department, flagged first, with Available impact |
| GET | `/queues/approvals` | F | HOD_ENDORSED reimbursements + SUBMITTED vendor requests + DELIVERED awaiting balance, flagged first then oldest |
| GET | `/queues/payments` | Mg | APPROVED reimbursements + payable milestones, grouped by payee with UPI / bank details |

### 20.12 Exports

Synchronous for MVP (volumes in section 14 are small); streamed as a file download.

| Method | Path | Roles | Output |
|---|---|---|---|
| GET | `/exports/transactions?format=csv|xlsx&…filters` | F, Mg; H own dept | Ledger (12.1) |
| GET | `/exports/department-statement/{id}?format=xlsx|pdf` | own H, F, Mg | 12.2, with document links |
| GET | `/exports/payment-batch?format=csv|xlsx` | Mg, F | 12.3 |
| GET | `/exports/vendor-ledger?format=xlsx` | F, Mg | 12.4 |
| GET | `/exports/income-ledger?format=xlsx` · `/exports/sponsor-statement/{id}?format=pdf` | F, Mg | 12.5 |
| GET | `/exports/fest-summary?format=pdf|xlsx` | F, Mg | 12.6 |
| GET | `/exports/audit?format=csv&from=&to=` | F, Mg | 12.7 |

### 20.13 AI and cron

| Method | Path | Roles | Purpose |
|---|---|---|---|
| POST | `/ai/ocr` | uploader, F | `{ attachment_id }` — (re)run OCR; returns `ocr_json` `{ merchant, date, total_paise, tax_paise, line_items[], confidence }` |
| POST | `/cron/ticket-sla` | `CRON_SECRET` | Triage-overdue reminders, second-interval auto-escalation, due-date-passed notices, DONE reminder at 24 h, auto-close at 48 h |
| POST | `/cron/vendor-overdue` | `CRON_SECRET` | F12 for expected delivery dates passed |
| POST | `/cron/daily-digest` | `CRON_SECRET` | Section 10 digest to F, Mg, opted-in HODs |
| POST | `/cron/income-followups` | `CRON_SECRET` | Pledges unreceived past `income_followup_days` |
| POST | `/cron/gc-attachments` | `CRON_SECRET` | Delete unbound uploads older than 24 h |

Flag rules run inside the service layer (`lib/flags/rules/F1.ts` … `F14.ts`), each a pure function `(entity, context) → Flag | null`, invoked after every relevant write; `/flags/evaluate` only re-invokes them.

## 21. Handoff notes for Claude Code

### 21.1 Repository layout

```
app/
  (auth)/sign-in/                # landing treatment (9.1 rule 5)
  (app)/                         # dark app shell: sidebar, header, notifications
    dashboard/  requests/  vendors/  income/  tickets/  budget/  admin/  audit/
  api/v1/…                       # route handlers: parse → can() → service → respond
lib/
  authz.ts                       # can(user, action, resource) + segregation rules
  state-machines/                # reimbursement.ts  vendor.ts  ticket.ts  line-item.ts  (tables + assertTransition)
  services/                      # one module per resource; all writes + audit in one transaction
  flags/rules/                   # F1.ts … F14.ts, pure functions; index.ts runs the relevant set
  money.ts                       # paise helpers, ₹ formatting with Indian grouping
  human-id.ts                    # per-fest sequences
  storage.ts  email.ts  ai.ts    # R2, Resend, Anthropic wrappers
db/
  schema.ts                      # Drizzle schema mirroring section 19
  migrations/                    # drizzle-kit output + 0002_views.sql (19.4)
  seed.ts                        # one fest, departments (incl. Finance, Core), users per role, expense types, sample line items with documents
emails/                          # React Email templates keyed by notification type
jobs/                            # cron handlers' logic (called by app/api/v1/cron/*)
tests/
  unit/                          # state machines (every from × action), authz, money, flag rules
  api/                           # route handlers against a Neon branch
  e2e/                           # Playwright: reimbursement end-to-end, vendor end-to-end, ticket end-to-end
```

### 21.2 Build order

Each milestone ends with tests green, seed data loaded, and a short demo path in the README.

| # | Milestone | Delivers |
|---|---|---|
| M1 | Foundation | Next.js + Tailwind theme (9.1), Clerk sign-in with domain restriction, Clerk webhook, `users` / `departments` / `fests`, `can()`, audit service, attachments upload flow (20.2), app shell with sidebar and notifications inbox |
| M2 | Budget | Fest total, departments, transfers, line items with supporting documents, `v_*` views, department and fest dashboards (five numbers), budget review screen, flags F13 / F14 |
| M3 | Reimbursements | Full 7.2 state machine, member form (mobile-first, camera), HOD endorsement queue, Finance approval queue, Management payment queue, flags F1–F6, email notifications, comments, timelines |
| M4 | Vendors and income | 7.3 state machine with milestones, vendor pages with exposure, flags F8 / F9 / F12, income ledger and tranches, cash position and projected close on the fest overview |
| M5 | Work tickets | 7.7 state machine, department inbox Kanban, outgoing, my tickets, fest-wide board and workload, similar-ticket lookup, cron SLA job, ticket notifications |
| M6 | Close-out | Exports 12.1–12.7, bulk approve, payment-batch export, audit log screens, daily digest, polish pass against section 9 |
| v1.1 | After launch | OCR auto-fill, F7 / F10 / F11, push / WhatsApp for Urgent tickets, ticket templates, light theme, SSE live updates |

### 21.3 Definition of done

- Every route handler calls `can()`; a test proves each role gets 403 on every endpoint it must not use (table in 5.1).
- State-machine tests cover every `from × action` pair, including segregation cases (HOD submitting, Finance HOD submitting, self-approval attempts).
- The five numbers for a seeded department match a hand-computed fixture after a scripted sequence: submit → endorse → approve → pay, plus a vendor advance and a balance adjustment.
- No `number` arithmetic on rupees anywhere; `money.ts` is the only place amounts are formatted.
- Every write produces an audit event with `before` / `after`; `audit_events` has no UPDATE / DELETE grants for the app role.
- Attachments are never served from a public URL, except the signed bill links in the reimbursement export (section 11).
- `pnpm test`, `pnpm lint`, `pnpm typecheck` pass; `pnpm db:seed` produces a usable demo.

### 21.4 Decisions already made (do not re-ask)

- Line items are open on creation; there is no approval gate (open question 20 pending). Flags F13 / F14 and the budget-review screen are the control; the document threshold is off by default (7.1, open question 21).
- Finance and Core are departments (`kind`); Finance HODs and Management users belong to them.
- Over-budget requests are flagged, never blocked. The only hard blocks are `OVER_ALLOCATION` (fest total, department allocation, line-item minimum) and the supporting-document threshold for attaching requests — and that threshold ships at 0, so a deployment that never sets it has `OVER_ALLOCATION` as its only hard block.
- Pending is subtracted from Available.
- Payments are recorded, never executed.
- Email is the only channel in MVP; in-app notifications are stored regardless so push can be added later without schema changes.
- Dark theme only in MVP; exports and emails are light.

### 21.5 Where to use judgment

- Any open question in section 17: proceed with the stated draft, note the assumption in the README, and surface it in the milestone demo.
- UI layout within the constraints of 9.1. Match the site's dashboard page density, not a marketing page.
- Exact email copy, as long as every email links to the record and states the next action and who owns it.