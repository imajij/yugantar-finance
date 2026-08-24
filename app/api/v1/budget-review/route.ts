import { route } from "@/lib/api";
import { budgetReview } from "@/lib/services/line-items";

/**
 * PRD 20.5 — Finance's review sweep. Unreviewed items above the document threshold
 * come first, then anything planned above its own lowest quote.
 */
export const GET = route(async ({ user }) => ({ data: await budgetReview(user), next_cursor: null }));
