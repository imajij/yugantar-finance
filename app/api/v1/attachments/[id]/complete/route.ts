import { route } from "@/lib/api";
import { completeUpload } from "@/lib/services/attachments";

/** PRD 20.2 step 3 — confirm the object landed and hash it for F1's duplicate check. */
export const POST = route<{ id: string }>(({ user, params }) => completeUpload(user, params.id));
