import { route } from "@/lib/api";
import { setWatcher } from "@/lib/services/tickets";

/** PRD 20.9 — watch a ticket. Yourself always; anyone else is the target HOD's call. */
export const POST = route<{ id: string; userId: string }>(({ user, params }) =>
  setWatcher(user, params.id, params.userId, true),
);

export const DELETE = route<{ id: string; userId: string }>(({ user, params }) =>
  setWatcher(user, params.id, params.userId, false),
);
