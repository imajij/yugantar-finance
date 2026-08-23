import { z } from "zod";
import { route } from "@/lib/api";
import { EXPORT_KINDS, runExport, type ExportKind } from "@/lib/services/exports";
import { recordAudit } from "@/lib/services/audit";
import { db } from "@/db";

const kindSchema = z.enum(EXPORT_KINDS as [ExportKind, ...ExportKind[]]);

/** PRD 12 — CSV out. Running an export is itself an audited event (10.1). */
export const GET = route<{ kind: string }>(async ({ user, params }) => {
  const kind = kindSchema.parse(params.kind);
  const body = await runExport(user, kind);

  await db.transaction((tx) => recordAudit(tx, {
    festId: user.festId, entityType: "FEST", entityId: user.festId, actorId: user.id,
    action: "export.run", after: { kind },
  }));

  const today = new Date().toISOString().slice(0, 10);
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="yugaantar-${kind}-${today}.csv"`,
    },
  });
});
