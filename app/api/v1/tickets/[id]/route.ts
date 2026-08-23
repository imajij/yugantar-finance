import { route } from "@/lib/api";
import { getTicketDetail } from "@/lib/services/tickets";

export const GET = route<{ id: string }>(async ({ user, params }) => getTicketDetail(user, params.id));
