import { route } from "@/lib/api";
import { attachmentUrl } from "@/lib/services/attachments";

/**
 * PRD 20.2 — a signed GET URL that expires in fifteen minutes.
 *
 * This endpoint is the access control on every receipt, invoice and MoU in the
 * system: the service checks that the caller can see the parent record before a
 * URL exists at all (PRD 11).
 */
export const GET = route<{ id: string }>(({ user, params }) => attachmentUrl(user, params.id));
