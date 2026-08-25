# Yugaantar Finance & Operations — design brief

A handoff document for redesigning the interface. It describes what the product is,
who uses it under what conditions, every screen as built, the design system already
in place, and — the part worth reading twice — where the current interface is weak
and what a redesign should actually solve.

Written against the code as it stands. Where this contradicts the PRD, the PRD's
section 9.1 is the source for brand and the code is the source for what exists.

---

## 1. What this is

A web dashboard that tracks every rupee of a college fest: the headline budget,
how it breaks down across departments and line items, every reimbursement and vendor
payment from request to payout, the sponsorship and ticket income that funds it, the
cross-department work tickets, and now the per-department chat.

It is not a generic admin tool. It is the financial record of one event, run by
students, audited afterwards by people who were not there. Two properties follow
from that, and both should show in the design:

- **Every number is derived.** Nobody types "utilized". The five figures come from
  SQL views over the transactions. The interface's job is to make derived numbers
  feel trustworthy — which mostly means never letting two screens disagree, and
  always showing what a number is made of.
- **Everything is on the record.** Soft deletes, an append-only audit log, a reason
  required on anything consequential. The interface should make that feel like
  protection rather than bureaucracy.

## 2. Who uses it, and when

Four roles plus an orthogonal administrator flag. But the condition that should
drive the design is *when*:

| | Before the fest | Fest week | After |
|---|---|---|---|
| Who | Finance HOD, dept HODs | Everyone, constantly | Finance HOD, Management |
| Where | Laptops, unhurried | **Phones, standing up, loud, in a hurry** | Laptops |
| What | Set budgets, break down line items, invite people | Submit receipts, endorse, approve, pay, chase tickets | Close-out, exports, audit |

**Fest week is the design target.** A Member photographing a receipt at 11pm outside
a venue is the hardest case and the most common one. An HOD triaging fourteen
tickets between two events is the second. Everything else can afford a laptop and a
calm minute.

The current interface is built desktop-first with a mobile fallback. That is
backwards for the two flows above.

## 3. The one concept everything hangs off

Five numbers, at three levels (line item → department → fest). They appear on almost
every screen and they must read identically everywhere:

```
Allocated   money assigned to this department
Pending     requests awaiting a decision       (subtracted — you cannot spend twice)
Committed   approved, not yet paid
Spent       paid
Available   Allocated − Pending − Committed − Spent
```

**Pending is subtracted from Available.** This is the single most confusing thing in
the product: HODs see less money than they expect and do not know why. The current
design shows Pending as a card among five equal cards, which explains nothing.
Making this legible is a specific brief item (§7).

Money is **integer paise**, formatted in one place: `₹1,23,456.00`, Indian digit
grouping, tabular numerals, right-aligned in every table. Non-negotiable.

## 4. Roles, and what each one actually sees

| Role | Sees | Acts |
|---|---|---|
| **Member** | Own requests; own department's line items and Available (read-only); tickets they raised or are assigned; their department's channels | Submit reimbursements, raise tickets, comment |
| **Department HOD** | Everything a Member has, plus their whole department's budget, requests and vendor requests | Endorse their department's requests, manage line items within the cap, raise vendor requests, triage the ticket inbox, run their channels, **ask for a bigger allocation** |
| **Finance HOD** | Every department's money | Approve reimbursements, approve vendor requests, allocate budgets, resolve flags, manage users and settings |
| **Management** | Every department's money, read-only | **Record payments** — and nothing else moves money out |
| **Administrator** (a flag, not a role) | Audit log, close-out pack, every department's numbers, **every chat channel** | Appoint other administrators, allocate budgets. **Never gains spending authority** |

Two consequences the design must carry:

- **Segregation of duties is visible in the UI as absence.** A Finance HOD sees no
  "record payment" button because they may never press one — not even on their own
  request. When somebody cannot do something, the control is gone, not disabled.
- **The administrator flag is orthogonal to role.** A Member who is an administrator
  sees the audit log and every channel, and still cannot approve a ₹200 claim. The
  UI currently gives no visual signal for "you are seeing this because you are an
  administrator" except on channels. It should.

## 5. Screen inventory

Twenty-seven routes. Grouped by what somebody is trying to do.

### Money

| Route | Purpose | State |
|---|---|---|
| `/dashboard` | Role-dependent landing. Five numbers, queues, flags, recent activity | Works, but is a flat wall of equal-weight cards with no hierarchy |
| `/budget` | Every department's five numbers, allocation controls, allocation-request queue, stall warnings | Dense table, horizontally scrolling below ~48rem |
| `/budget/[id]` | One department: five numbers, line items with utilization, create/edit/close, ask for a budget | Table is `min-w-[54rem]`; unusable on a phone |
| `/budget/[id]/line-items/[itemId]` | One line item: numbers, supporting documents, quote comparison, timeline | Fine |
| `/budget/review` | Finance's sweep: every line item, unreviewed-above-threshold first | Long list, no grouping |
| `/income` | Sponsorship and ticket income; pledged vs received | Fine |
| `/close-out` | End-of-fest pack, administrators only | Fine |

### Requests

| Route | Purpose | State |
|---|---|---|
| `/requests` | My requests (Member) or the department's (HOD) | Card list, works |
| `/requests/new` | **The most important screen in the product.** Receipt, line item, expense type, reason, date, amount, payee | Long vertical form; desktop-shaped; camera capture works but nothing else is phone-designed |
| `/requests/[id]` | One request: amounts, receipts, flags, timeline, comments, transition actions | Works. Actions are a row of buttons with `window.prompt` for reasons — genuinely bad |
| `/queues` | Whichever queue your role owns: endorse / approve / pay | Works; stall warnings added recently |
| `/vendors`, `/vendors/[id]`, `/vendors/new` | Vendor register and exposure | Fine |
| `/vendors/requests/[id]`, `/vendors/requests/new` | Vendor payment requests and milestones | Milestone UI is cramped |

### Work

| Route | Purpose | State |
|---|---|---|
| `/tickets` | Linear-style board: board/list, grouping by seven axes, filters, inline editing, keyboard | Newest and densest screen. Closest to right |
| `/tickets/[id]` | One ticket: detail, sub-tickets, actions, timeline, comments | Works |
| `/tickets/new` | Raise a ticket, with planning fields behind a disclosure | Works |
| `/tickets/planning` | Labels, projects, cycles | Utilitarian |
| `/chat`, `/chat/[id]` | Department channels and DMs, threads, files, record links | New. Fights the app shell — see §7 |

### Oversight and setup

| Route | Purpose | State |
|---|---|---|
| `/flags` | The flag queue: rules F1–F14 plus hand-raised concerns | Works |
| `/audit` | Append-only log, filterable | Dense, hard to scan |
| `/admin` | Users, roles, departments, expense types, thresholds, fest settings | A stack of tables in cards; the least designed screen |
| `/notifications` | In-app inbox | Fine |
| `/sign-in` | Magic-link or Clerk | The only screen allowed the fest's landing-page treatment |

## 6. The design system as built

### Tokens

Dark only. Light exists for **emails and PDF exports** and nowhere else.

```css
/* Surfaces */
--yg-bg:        #06061f;  /* sign-in screen only */
--yg-bg-app:    #13141f;  /* app background */
--yg-surface:   #1a1b2e;  /* cards, sidebar, table rows */
--yg-surface-2: #2a2b3d;  /* borders, dividers, hover */

/* Brand */
--yg-lime:      #d2fc3c;  /* primary actions, active nav */
--yg-yellow:    #eece00;  /* the ONE most important action on a screen */
--yg-pink:      #f5449e;  /* secondary buttons and links */
--yg-sky:       #7fd5ff;  /* highlighted text */

/* Text */
--yg-text:      #ffffff;
--yg-text-soft: #c0c0c0;
--yg-text-muted:#a0a0b0;
--yg-on-accent: #06061f;  /* text on lime or yellow */
```

**Semantic state palette — brand colours never encode state.**

| Meaning | States | Text / Background |
|---|---|---|
| Waiting on someone | DRAFT, SUBMITTED, HOD_ENDORSED, OPEN, NEEDS_INFO, BACKLOG, Pending | `#f5c542` / `#3d2f0a` |
| Moving | ACCEPTED, IN_PROGRESS, ADVANCE_PAID, DELIVERED | `#7fd5ff` / `#0e2a3d` |
| Decided, one step left | APPROVED, BALANCE_APPROVED, DONE, Committed | `#d2fc3c` / `#263a0a` |
| Finished well | PAID, CLOSED, Spent | `#90ee90` / `#1f4d1f` |
| Finished badly | DECLINED, REJECTED, CANCELLED, WITHDRAWN | `#ee9090` / `#4d1f1f` |
| Stuck | ON_HOLD, BLOCKED, SENT_BACK | `#b39dff` / `#241452` |
| Flag High / Medium / Low | | `#ee9090` / `#f5c542` / `#a0a0b0` on matching tints |

Every pair clears WCAG AA on its background. **Re-verify any new pair.**

### Type

| Use | Font |
|---|---|
| UI text, forms, tables, buttons | **Lexend** 400 / 500 / 700 |
| Page titles, section headings, the five numbers' labels | **Reem Kufi Fun** 400 / 700 |
| Amounts, UTRs, ticket IDs, dates in tables | **Source Code Pro**, `tabular-nums`, right-aligned |

Loaded via `next/font/google` as CSS variables. Display fonts from the fest posters
(LC Mogi, Monomaniac One) are allowed on `/sign-in` only.

The scale is currently almost unused: nearly everything is `text-sm` or `text-xs`,
with `text-2xl` on page titles. **A real typographic scale is part of the brief.**

### Components that exist

`Card` · `StatCard` (one of the five numbers) · `StateChip` (pill, always with a text
label) · `FlagChip` · `Amount` (tabular, ₹, Indian grouping) · `UtilizationBar` ·
`PageTitle` · `Empty` · `Timeline` · `CommentThread` · `TransitionActions` ·
`RaiseConcern` · sidebar + mobile nav strip.

Icons: **lucide-react**, 13–16px inline, always with `aria-hidden` and a text label
beside them.

### Rules that must not break

1. **Dark in the app. Light in emails and exports.** Not a preference; the exports
   get printed and filed.
2. **Lime is primary. Yellow is the single most important action on a screen** —
   Submit, Approve, Record payment, Accept. If two things are yellow, one is wrong.
   Pink is secondary and links.
3. **State is never colour alone.** Every chip carries its label. Fest week happens
   at night on cheap phone screens.
4. **Money is always tabular, ₹-prefixed, Indian-grouped, right-aligned in tables.**
5. **No gradients, background art, or display fonts inside the app.** The landing
   treatment stops at the sign-in screen.
6. **Absent, not disabled.** A control somebody may never use is not rendered. A
   disabled Approve button invites them to ask why.

## 7. Where it falls down — the actual brief

Honest assessment of the current interface, worst first.

### 7.1 It is desktop-shaped and the hard case is a phone

`/requests/new` is the screen a Member uses standing outside a venue at 11pm with
one hand. It is currently a vertical stack of eleven labelled inputs. The budget
tables are `min-w-[48rem]` to `min-w-[54rem]` and scroll horizontally on a phone,
which is where an HOD checks Available before saying yes to someone.

**Ask:** a genuinely phone-first treatment of receipt submission and of "how much has
my department got left", and a table strategy that degrades to something readable
rather than something scrollable.

### 7.2 There is no hierarchy — everything is a card of equal weight

The dashboard, `/budget`, and `/admin` are all vertical stacks of `Card`s at the
same elevation, same padding, same border. The five numbers get `StatCard`s that
differ from an ordinary card only by having a bigger number in them. Nothing on any
screen says "look here first".

**Ask:** a hierarchy — a primary figure treatment, a secondary supporting treatment,
and a tertiary/metadata treatment — and a rule for which is used when.

### 7.3 Pending is unexplained, and it is the thing people get wrong

Available is lower than HODs expect because Pending is subtracted. The five cards
sit in a row with no relationship shown between them. Nothing communicates that
Available is a *derivation*.

**Ask:** a treatment for the five numbers that shows the arithmetic — the parts and
the remainder — rather than five sibling boxes. This is the single highest-value
piece of visual design in the product.

### 7.4 Actions that need a reason use `window.prompt`

Rejecting, blocking, sending back, closing a line item — all consequential, all
requiring a written reason that goes into the permanent record — currently open a
browser prompt dialog. It is ugly, unstyled, uncopyable, and utterly at odds with
"everything is on the record".

**Ask:** a proper confirm-with-reason pattern. It is used a dozen places and should
be one component.

### 7.5 Feedback is ad-hoc

Errors appear as inline red text in some places and as a tinted banner in others.
There are no loading states — pages are server-rendered and swap whole. Nothing
acknowledges a successful write except the page changing.

**Ask:** one error pattern, one success pattern, one pending pattern, and a decision
about what happens visually in the gap between clicking Approve and the page
returning.

### 7.6 Navigation is a flat list of twelve

The sidebar is twelve ungrouped items. The mobile version is a horizontally
scrolling strip of the same twelve, which is close to unusable. Nothing groups
*money* / *work* / *oversight*, and nothing indicates the current section.

**Ask:** grouped navigation, an honest mobile pattern, and a visible current-location
indicator.

### 7.7 Density is inconsistent across the newest screens

`/tickets` (board) and `/chat` were built most recently and are much denser than the
rest. `/chat` sets its own height with `calc(100vh - 2rem)` and fights the app shell.
`/admin` is the least designed screen and holds the most controls.

**Ask:** one density scale applied across all screens, and an app shell that supports
both a scrolling document (`/budget`) and a fixed two-pane layout (`/chat`).

### 7.8 Tap targets are too small

Icon buttons are `p-1.5` around a 13–14px icon — roughly 26–28px. The floor is 44px
for anything used during fest week.

### 7.9 Empty and first-run states are one grey sentence

`Empty` renders a single line of muted text. A fest that has just been created is
*entirely* empty states, and that is a new Finance HOD's first impression of the
product.

**Ask:** real empty states that say what the thing is for and what to do next.

## 8. Technical constraints for the implementation

Read these before designing something that cannot be built here.

- **Next.js 16 App Router, React 19, server components by default.** Most screens
  fetch on the server and render as HTML. Interactive pieces (`board.tsx`,
  `conversation.tsx`, forms) are explicit client components. A design assuming
  client-side state everywhere will fight the architecture and lose.
- **Navigation is a real page load** in most places. Design for that rather than for
  an SPA.
- **Tailwind v4 with CSS custom properties**, no config file. Brand colours are used
  as `var(--yg-*)` in inline `style` props because they are not in Tailwind's
  palette. That is deliberate and works; keep the token names.
- **No component library, no CSS-in-JS runtime, no animation library.** Adding one is
  a decision, not a given.
- **lucide-react** for icons.
- **No image assets in the app** beyond the wordmark. There is no favicon yet — one
  is wanted (a lime "Y").
- **Emails** are table-based HTML in `emails/`, dark, built for mail clients rather
  than browsers. **PDF exports** are light-themed A4 HTML the browser prints. Both
  need their own treatment and neither can use the app's CSS.
- Amount formatting lives in `lib/money.ts` and state colours in `lib/state-chip.ts`.
  Both are single sources of truth; route new work through them.

## 9. Voice

The interface talks like a competent colleague, not a system.

- Refusals explain themselves: *"Tech has already committed or spent ₹40,000, so its
  allocation cannot go below that"* — not *"Validation failed"*.
- Numbers come with their basis: *"over by ₹2,400"*, *"₹4,200 available"*.
- Consequences are stated before they happen: *"Closing releases the unspent balance
  back to the department."*
- Nothing is hidden that a person would want to know. The chat channel header says
  *"Administrators can read this channel"* in plain words rather than burying it.

Keep this. It is most of what makes the product feel trustworthy, and it is easy to
design away by shortening labels.

## 10. Out of scope — do not redesign these

- **The five numbers' definitions** and the words Allocated / Pending / Committed /
  Spent / Available. They are the PRD's contract and they appear in exports and
  audits.
- **State names.** DRAFT, SUBMITTED, HOD_ENDORSED, APPROVED, PAID and the rest are
  the state machine, not labels.
- **The semantic colour mapping.** Restyle the chip; keep which state is which colour.
- **The administrator disclosure line** in channel headers.
- **Segregation of duties as absence.** Do not turn missing controls into disabled
  ones.

## 11. What would be most useful back

In rough priority order:

1. The five-numbers treatment (§7.3) — one component, three levels, showing the
   arithmetic.
2. Phone-first receipt submission (§7.1).
3. The confirm-with-reason pattern (§7.4).
4. A typographic and density scale, applied to two contrasting screens — `/budget`
   (dense, tabular) and `/requests/new` (form, phone).
5. Navigation, grouped, with a mobile pattern (§7.6).
6. Empty and first-run states (§7.9).
7. A favicon and, if the vector original can be found, a proper wordmark lockup.

Screens worth designing in full, as they exercise everything else: `/dashboard`,
`/budget/[id]`, `/requests/new`, `/requests/[id]`, `/tickets`, `/chat/[id]`.
