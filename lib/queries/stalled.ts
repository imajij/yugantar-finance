/**
 * Money that has stopped moving because nobody holds the role that must act next.
 *
 * The five numbers were right and the screen still looked broken: ₹2.00 sat in
 * Committed with Spent at zero and nothing anywhere saying why. The reason was that
 * the fest's only Management account had never accepted its invitation, and PRD
 * 5.2 puts recording a payment with Management and nobody else — so the request was
 * approved, correct, and unpayable, and would have stayed that way through the
 * whole fest.
 *
 * That is not an arithmetic bug and it should not be fixed by loosening 5.2. It is
 * a gap in what the app *says*: a segregated workflow can deadlock on an empty
 * seat, and the only person who can see the deadlock — Finance, looking at a
 * Committed figure that never moves — is not the person the queue belongs to.
 *
 * So this answers one question for whoever is looking at the budget: is anything
 * waiting on a role nobody currently holds?
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { Actor } from "@/lib/authz";

export interface StalledStage {
  /** The statuses that are waiting. */
  statuses: string[];
  /** What the reader should understand is stuck. */
  label: string;
  /** The role that has to act, in the words the admin screen uses. */
  needs: "MANAGEMENT" | "FINANCE_HOD" | "DEPT_HOD";
  needsLabel: string;
  count: number;
  amountPaise: number;
  /** Whether anybody active holds that role. False is the whole point of this file. */
  hasSomebody: boolean;
  /** Present when there is somebody, but they have not accepted their invitation. */
  invitedNotActive: number;
}

const STAGES: { statuses: string[]; label: string; needs: StalledStage["needs"]; needsLabel: string }[] = [
  {
    statuses: ["APPROVED", "ON_HOLD"],
    label: "approved and waiting to be paid",
    needs: "MANAGEMENT",
    needsLabel: "Management",
  },
  {
    statuses: ["HOD_ENDORSED"],
    label: "endorsed and waiting on approval",
    needs: "FINANCE_HOD",
    needsLabel: "the Finance HOD",
  },
];

/**
 * Only the stages that are genuinely blocked: something is waiting *and* no active
 * account holds the role. A queue with a person on the other end is just a queue.
 */
export async function stalledStages(actor: Actor): Promise<StalledStage[]> {
  // `in ${array}` and not `= any(array)`: drizzle renders a JS array as a tuple,
  // so the array form asks Postgres to cast a record and fails at runtime.
  const waiting = (await db.execute(sql`
    select r.status::text as status, count(*)::int as n,
           coalesce(sum(r.amount_paise), 0)::bigint as amount
      from reimbursement_requests r
     where r.fest_id = ${actor.festId} and r.deleted_at is null
       and r.status::text in ${STAGES.flatMap((s) => s.statuses)}
     group by r.status
  `)) as unknown as { status: string; n: number; amount: string }[];

  const seats = (await db.execute(sql`
    select role::text as role,
           count(*) filter (where status = 'ACTIVE')::int  as active,
           count(*) filter (where status = 'INVITED')::int as invited
      from users where fest_id = ${actor.festId}
     group by role
  `)) as unknown as { role: string; active: number; invited: number }[];

  const bySeat = new Map(seats.map((s) => [s.role, s]));

  return STAGES
    .map((stage) => {
      const rows = waiting.filter((w) => stage.statuses.includes(w.status));
      const seat = bySeat.get(stage.needs);
      return {
        ...stage,
        count: rows.reduce((sum, r) => sum + Number(r.n), 0),
        amountPaise: rows.reduce((sum, r) => sum + Number(r.amount), 0),
        hasSomebody: Number(seat?.active ?? 0) > 0,
        invitedNotActive: Number(seat?.invited ?? 0),
      };
    })
    .filter((s) => s.count > 0 && !s.hasSomebody);
}
