import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { fests } from "@/db/schema";
import { notFound, parseBody, route } from "@/lib/api";
import { can } from "@/lib/authz";
import { setTotalBudget } from "@/lib/services/budget";
import { updateFestSettings } from "@/lib/services/admin";

/** PRD 20.4 — the fest record. `settings` is Finance's business only. */
export const GET = route(async ({ user }) => {
  const [fest] = await db.select().from(fests).where(eq(fests.id, user.festId)).limit(1);
  if (!fest) throw notFound("Fest");
  if (can(user, "fest.settings.view", { festId: user.festId })) return fest;
  // Flag thresholds and reminder intervals are Finance's controls, not everyone's.
  const { settings: _settings, ...withoutSettings } = fest;
  void _settings;
  return withoutSettings;
});

const patch = z.object({
  total_budget_paise: z.number().int().nonnegative().optional(),
  reason: z.string().min(3).max(500).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

/**
 * PRD 20.4 — Finance edits the fest. The total budget goes through `setTotalBudget`
 * rather than a plain update, because it cannot fall below Σ allocations and that
 * check has to hold under concurrency.
 */
export const PATCH = route(async ({ user, request }) => {
  const b = await parseBody(request, patch);

  if (b.total_budget_paise !== undefined) {
    await setTotalBudget(user, b.total_budget_paise, b.reason ?? "Fest total updated");
  }
  if (b.settings) {
    return updateFestSettings(user, b.settings);
  }

  const [fest] = await db.select().from(fests).where(eq(fests.id, user.festId)).limit(1);
  return fest;
});
