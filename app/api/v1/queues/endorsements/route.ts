import { route } from "@/lib/api";
import { endorsementQueue } from "@/lib/queries/queues";

/** PRD 20.11 — SUBMITTED requests for my department, flagged first, with the Available impact. */
export const GET = route(async ({ user }) => ({ data: await endorsementQueue(user), next_cursor: null }));
