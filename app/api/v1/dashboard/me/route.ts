import { route } from "@/lib/api";
import { myDashboard } from "@/lib/queries/dashboards";

/** PRD 20.11 — my requests, my tickets, and what is waiting on me. */
export const GET = route(({ user }) => myDashboard(user));
