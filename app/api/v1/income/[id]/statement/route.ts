import { route } from "@/lib/api";
import { sponsorStatement } from "@/lib/services/income";

/** PRD 20.8 — the sponsor-wise statement as JSON; the PDF form lives under /exports. */
export const GET = route<{ id: string }>(({ user, params }) => sponsorStatement(user, params.id));
