import { route } from "@/lib/api";
import { markRead } from "@/lib/services/notifications";

/** PRD 20.10 — mark one notification read. Self only; `markRead` scopes by recipient. */
export const POST = route<{ id: string }>(({ user, params }) => markRead(user, [params.id]));
