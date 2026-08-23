import { route } from "@/lib/api";
import { festDashboard } from "@/lib/queries/dashboards";

/** PRD 20.11 — "where do we stand?" answered in one call. Finance and Management. */
export const GET = route(({ user }) => festDashboard(user));
