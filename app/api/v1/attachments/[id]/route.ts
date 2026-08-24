import { route } from "@/lib/api";
import { getAttachment, removeAttachment } from "@/lib/services/attachments";

/** PRD 20.2 — metadata plus `ocr_json`. Visible to anyone who can see the parent. */
export const GET = route<{ id: string }>(({ user, params }) => getAttachment(user, params.id));

/** Soft remove (18.2 rule 7). The object stays in the bucket; the row stops counting. */
export const DELETE = route<{ id: string }>(({ user, params }) => removeAttachment(user, params.id));
