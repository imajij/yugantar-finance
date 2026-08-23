/**
 * The one sanctioned way past the append-only guard on `audit_events` (18.2 rule 7),
 * and the shared teardown built on it.
 *
 * The seed and the database tests both need to tear a fest down and rebuild it, and
 * the trigger from `0003_append_only_audit.sql` correctly refuses to let them. So
 * they set `app.allow_audit_mutation` — with `SET LOCAL`, so it lives for exactly
 * one transaction on exactly one connection — and the trigger stands aside.
 *
 * What keeps that from being a loophole: the trigger was never the real control.
 * The application's database role has UPDATE and DELETE on `audit_events` revoked
 * outright (see the grants in that migration), and no session setting can hand them
 * back. The trigger is the second layer, for a database provisioned without that
 * role — a local Docker container, a preview branch — and this is its documented,
 * greppable exception.
 *
 * Nothing under `app/` or `lib/services/` may import this module.
 */
import { sql } from "drizzle-orm";

/** Just enough of a Drizzle client to run statements in a transaction. */
export interface Runner {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
}

/**
 * The app's `db`, or the seed script's own client. Typed structurally so both fit:
 * they are Drizzle instances over different schemas, which are otherwise unrelated
 * types.
 */
export interface Executor {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the two clients are Drizzle instances over different schemas; only `execute` is used
  transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
}

/**
 * Runs `fn` with the audit guard stood down for the length of one transaction.
 * `fn` receives the transaction and must do its work through it — a statement run
 * on any other connection is outside the `SET LOCAL` and will still be refused.
 */
export async function withAuditGuardLifted<T>(
  exec: Executor,
  fn: (tx: Runner) => Promise<T>,
): Promise<T> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("The audit guard is never lifted in production");
  }

  return exec.transaction(async (raw: Runner) => {
    const tx = raw;
    await tx.execute(sql`set local app.allow_audit_mutation = 'on'`);
    return fn(tx);
  });
}

/**
 * Tears down every fest whose slug starts with `prefix`, in foreign-key order.
 *
 * The database tests each build a fest, exercise it, and must leave nothing behind:
 * a run that leaks rows makes the next run's failures depend on the previous one's,
 * which is the fastest way to lose trust in a suite. Centralising the order here
 * also means a new table is one line, not six near-identical teardowns that drift.
 */
export async function dropFests(exec: Executor, prefix: string): Promise<void> {
  const like = `${prefix}%`;
  const scope = sql`(select id from fests where slug like ${like})`;

  await withAuditGuardLifted(exec, async (tx) => {
    for (const stmt of [
      sql`delete from income_tranches where income_entry_id in (select id from income_entries where fest_id in ${scope})`,
      sql`delete from income_entries where fest_id in ${scope}`,
      sql`delete from vendor_milestones where vendor_request_id in (select id from vendor_requests where fest_id in ${scope})`,
      sql`delete from vendor_requests where fest_id in ${scope}`,
      sql`delete from reimbursement_requests where fest_id in ${scope}`,
      sql`delete from comment_mentions where comment_id in (select id from comments where fest_id in ${scope})`,
      sql`delete from comments where fest_id in ${scope}`,
      sql`delete from ticket_watchers where ticket_id in (select id from tickets where fest_id in ${scope})`,
      sql`delete from tickets where fest_id in ${scope}`,
      sql`delete from entity_links where fest_id in ${scope}`,
      sql`delete from notifications where fest_id in ${scope}`,
      sql`delete from flags where fest_id in ${scope}`,
      sql`delete from audit_events where fest_id in ${scope}`,
      sql`delete from attachments where fest_id in ${scope}`,
      sql`delete from vendors where fest_id in ${scope}`,
      sql`delete from line_items where fest_id in ${scope}`,
      sql`delete from expense_types where fest_id in ${scope}`,
      sql`delete from idempotency_keys where user_id in (select id from users where fest_id in ${scope})`,
      sql`delete from budget_transfers where fest_id in ${scope}`,
      sql`delete from ticket_templates where fest_id in ${scope}`,
      sql`delete from users where fest_id in ${scope}`,
      sql`delete from human_id_sequences where fest_id in ${scope}`,
      sql`delete from departments where fest_id in ${scope}`,
      sql`delete from fests where slug like ${like}`,
    ]) await tx.execute(stmt);
  });
}
