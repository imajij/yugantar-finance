import { assertCan } from "@/lib/authz";
import { route } from "@/lib/api";
import { festTotals, incomeTotalsByType } from "@/lib/queries/budget";

/** PRD 20.8 — v_income_totals by type plus the fest cash position. */
export const GET = route(async ({ user }) => {
  assertCan(user, "income.view", { festId: user.festId });
  const [byType, totals] = await Promise.all([
    incomeTotalsByType(user.festId),
    festTotals(user.festId),
  ]);
  return {
    by_type: byType.map((t) => ({
      type: t.type,
      pledged_paise: t.pledgedPaise,
      received_paise: t.receivedPaise,
      expected_paise: t.expectedPaise,
      counts_toward_cash: t.type !== "SPONSORSHIP_IN_KIND",
    })),
    income_received_paise: totals?.incomeReceivedPaise ?? 0,
    income_expected_paise: totals?.incomeExpectedPaise ?? 0,
    spent_paise: totals?.spentPaise ?? 0,
    cash_position_paise: totals?.cashPositionPaise ?? 0,
    projected_close_paise: totals?.projectedClosePaise ?? 0,
  };
});
