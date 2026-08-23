import { route } from "@/lib/api";
import { departmentDashboard } from "@/lib/queries/dashboards";

/** PRD 20.11 — the five numbers for one department, its line items and recent activity. */
export const GET = route<{ id: string }>(({ user, params }) => departmentDashboard(user, params.id));
