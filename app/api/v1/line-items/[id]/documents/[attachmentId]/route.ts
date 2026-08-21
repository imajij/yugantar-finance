import { route } from "@/lib/api";
import { removeDocument } from "@/lib/services/line-items";

/** PRD 20.5 — soft remove; the file is retained and the removal is logged. */
export const DELETE = route<{ id: string; attachmentId: string }>(async ({ user, params }) =>
  removeDocument(user, params.id, params.attachmentId),
);
