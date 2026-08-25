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
 * Tears down every fest matching a slug pattern, in foreign-key order.
 *
 * The order is the whole value of this function, and it is subtle: `budget_transfers`
 * and `idempotency_keys` point at `users`, so they have to go first, and every table
 * pointing at `fests` has to go before it. Getting that wrong fails loudly but only
 * once there is data of the right shape, which is exactly when nobody is looking.
 *
 * So it lives here once, and both callers use it — the database tests, which must
 * leave nothing behind (a run that leaks rows makes the next run's failures depend
 * on the previous one's), and the seed's `--reset`.
 */
async function dropFestsMatching(exec: Executor, like: string): Promise<void> {
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
      // Threads reference their parent message, so the replies go first.
      sql`delete from message_mentions where message_id in (select id from messages where fest_id in ${scope})`,
      sql`delete from messages where fest_id in ${scope} and parent_id is not null`,
      sql`delete from messages where fest_id in ${scope}`,
      sql`delete from channel_members where channel_id in (select id from channels where fest_id in ${scope})`,
      sql`delete from channels where fest_id in ${scope}`,
      sql`delete from ticket_watchers where ticket_id in (select id from tickets where fest_id in ${scope})`,
      sql`delete from ticket_label_links where ticket_id in (select id from tickets where fest_id in ${scope})`,
      // Sub-tickets reference their parent, so the children have to go first.
      sql`delete from tickets where fest_id in ${scope} and parent_id is not null`,
      sql`delete from tickets where fest_id in ${scope}`,
      sql`delete from ticket_labels where fest_id in ${scope}`,
      sql`delete from entity_links where fest_id in ${scope}`,
      sql`delete from notifications where fest_id in ${scope}`,
      sql`delete from flags where fest_id in ${scope}`,
      sql`delete from audit_events where fest_id in ${scope}`,
      sql`delete from attachments where fest_id in ${scope}`,
      sql`delete from vendors where fest_id in ${scope}`,
      sql`delete from line_items where fest_id in ${scope}`,
      sql`delete from expense_types where fest_id in ${scope}`,
      sql`delete from sessions where user_id in (select id from users where fest_id in ${scope})`,
      sql`delete from sign_in_tokens where user_id in (select id from users where fest_id in ${scope})`,
      sql`delete from idempotency_keys where user_id in (select id from users where fest_id in ${scope})`,
      // An approved allocation request points at the transfer it made.
      sql`delete from allocation_requests where fest_id in ${scope}`,
      sql`delete from budget_transfers where fest_id in ${scope}`,
      sql`delete from projects where fest_id in ${scope}`,
      sql`delete from cycles where fest_id in ${scope}`,
      sql`delete from ticket_templates where fest_id in ${scope}`,
      sql`delete from users where fest_id in ${scope}`,
      sql`delete from human_id_sequences where fest_id in ${scope}`,
      sql`delete from departments where fest_id in ${scope}`,
      sql`delete from fests where slug like ${like}`,
    ]) await tx.execute(stmt);
  });
}

/** Every fest whose slug starts with `prefix` — how the database tests clean up. */
export function dropFests(exec: Executor, prefix: string): Promise<void> {
  return dropFestsMatching(exec, `${prefix}%`);
}

/** Exactly one fest — what the seed's `--reset` tears down before rebuilding. */
export function dropFestBySlug(exec: Executor, slug: string): Promise<void> {
  // `_` and `%` are LIKE wildcards, and a slug is allowed to contain neither, but
  // escaping costs nothing and stops a stray one matching more than it should.
  return dropFestsMatching(exec, slug.replace(/[\\%_]/g, "\\$&"));
}
