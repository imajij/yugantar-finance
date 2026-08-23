import { route } from "@/lib/api";
import { markRead } from "@/lib/services/notifications";

/** PRD 20.10 — clear the inbox. */
export const POST = route(({ user }) => markRead(user));
