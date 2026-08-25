import { route } from "@/lib/api";
import { markRead } from "@/lib/services/chat";

/** An administrator's oversight read never moves anybody's marker. */
export const POST = route<{ id: string }>(async ({ user, params }) => markRead(user, params.id));
