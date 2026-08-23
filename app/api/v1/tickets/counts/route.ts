import { route } from "@/lib/api";
import { ticketCounts } from "@/lib/services/tickets";

export const GET = route(async ({ user }) => ticketCounts(user));
