import { z } from "zod";
import { db } from "@/db";
import { ApiError, parseQuery, route } from "@/lib/api";
import { enforce } from "@/lib/rate-limit";
import { recordAudit } from "@/lib/services/audit";
import { assertCanExport, EXPORT_KINDS, runExport, type ExportFormat, type ExportKind } from "@/lib/services/exports";

const kindSchema = z.enum(EXPORT_KINDS as [ExportKind, ...ExportKind[]]);

/** Section 12: every export is filterable by date range, department, state, line item, expense type, vendor, payee. */
const query = z.object({
  format: z.enum(["csv", "xlsx", "html", "pdf"]).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  department_id: z.uuid().optional(),
  status: z.string().max(40).optional(),
  line_item_id: z.uuid().optional(),
  expense_type_id: z.uuid().optional(),
  vendor_id: z.uuid().optional(),
  payee: z.string().max(120).optional(),
  /** The record a statement is about: `department-statement`, `sponsor-statement`. */
  id: z.uuid().optional(),
});

/** Statement-style exports render as a print-ready page; the rest are tables. */
const DEFAULT_FORMAT: Record<ExportKind, ExportFormat> = {
  transactions: "csv",
  "department-statement": "xlsx",
  "payment-batch": "csv",
  "vendor-ledger": "xlsx",
  "income-ledger": "xlsx",
  "sponsor-statement": "html",
  "fest-summary": "html",
  audit: "csv",
};

const HTML_CAPABLE: ExportKind[] = ["department-statement", "sponsor-statement", "fest-summary"];

/**
 * PRD 12 / 20.12 — the seven exports, synchronous and streamed as a download.
 *
 * Running an export is itself an audited event (PRD 11): these files leave the
 * platform and reach the college's accounts office, so who pulled which data and
 * when is part of the record.
 *
 * `format=pdf` is served as the print-ready HTML page rather than refused — the
 * browser's own "print to PDF" produces the artefact, and the alternative is a
 * rendering engine in a serverless bundle.
 */
export const GET = route<{ kind: string }>(async ({ user, params, request }) => {
  const kind = kindSchema.parse(params.kind);
  const q = parseQuery(request, query);

  // Permission first, then the quota: asking for something you may not have must
  // never spend a rate-limit slot.
  assertCanExport(user, kind);
  await enforce("export", user.id);

  const requested = q.format === "pdf" ? "html" : q.format;
  const format: ExportFormat = requested ?? DEFAULT_FORMAT[kind];

  if (format === "html" && !HTML_CAPABLE.includes(kind)) {
    throw new ApiError("VALIDATION_ERROR", `${kind} is a table export; ask for csv or xlsx`);
  }
  if ((kind === "department-statement" || kind === "sponsor-statement") && !q.id) {
    throw new ApiError("VALIDATION_ERROR", "This export is about one record; pass `id`");
  }

  const result = await runExport(user, kind, format, {
    from: q.from, to: q.to,
    departmentId: q.department_id ?? (kind === "department-statement" ? q.id : undefined),
    status: q.status,
    lineItemId: q.line_item_id,
    expenseTypeId: q.expense_type_id,
    vendorId: q.vendor_id,
    payee: q.payee,
    id: q.id,
  });

  await db.transaction((tx) => recordAudit(tx, {
    festId: user.festId, entityType: "FEST", entityId: user.festId, actorId: user.id,
    action: "export.run",
    after: { kind, format, filters: { ...q, format: undefined } },
  }));

  // An HTML statement opens in the browser to be printed; everything else downloads.
  const disposition = format === "html" ? "inline" : "attachment";

  return new Response(
    typeof result.body === "string" ? result.body : new Uint8Array(result.body),
    {
      headers: {
        "content-type": result.contentType,
        "content-disposition": `${disposition}; filename="${result.filename}"`,
        // These carry payee bank details and receipt data; no shared cache may hold them.
        "cache-control": "private, no-store",
      },
    },
  );
});
