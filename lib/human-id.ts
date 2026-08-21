/**
 * Human-readable IDs (PRD 18.2 rule 8) — YUG-142, RB-0231, VP-0042.
 * Allocated from per-fest sequences inside the creating transaction, so a rolled-back
 * create does not burn a number and two concurrent creates cannot collide.
 */
import { sql } from "drizzle-orm";
import type { Tx } from "@/db";

export const PREFIXES = { ticket: "YUG", reimbursement: "RB", vendorRequest: "VP" } as const;
export type HumanIdPrefix = (typeof PREFIXES)[keyof typeof PREFIXES];

/** RB and VP are zero-padded to four; ticket numbers are read aloud, so they are not. */
const PAD: Record<string, number> = { RB: 4, VP: 4, YUG: 0 };

export async function nextHumanId(tx: Tx, festId: string, prefix: HumanIdPrefix): Promise<string> {
  const rows = await tx.execute<{ last_value: number }>(sql`
    insert into human_id_sequences (fest_id, prefix, last_value)
    values (${festId}, ${prefix}, 1)
    on conflict (fest_id, prefix)
      do update set last_value = human_id_sequences.last_value + 1
    returning last_value
  `);
  const n = Number((rows as unknown as { last_value: number }[])[0].last_value);
  return `${prefix}-${String(n).padStart(PAD[prefix] ?? 0, "0")}`;
}
