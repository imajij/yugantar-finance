"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Link2, Plus, Trash2 } from "lucide-react";
import { Button, IconButton } from "@/components/ui";
import { ConfirmWithReason } from "@/components/confirm";
import { FileUpload, type Uploaded } from "@/components/file-upload";
import { rupeesToPaise } from "@/lib/money";

/**
 * Adding a quotation or a listing to a line item after it exists.
 *
 * The create form takes files without asking anything about them, because at that
 * moment somebody is breaking a budget down and has three photographs of quotes on
 * their phone. Here the line item already exists and the screen beside this is the
 * quote comparison — so this asks for the two things that comparison needs: what
 * the document is, and what it quotes.
 *
 * A link is a first-class kind of document, not a lesser one. Half of what a
 * department is pricing lives on a web page that will have changed by the time
 * anybody checks it, so the URL is recorded and a screenshot can be attached beside
 * it.
 */

const FIELD =
  "w-full rounded-[var(--r-control)] px-3.5 py-2.5 text-[13.5px] bg-[var(--yg-bg-app)] "
  + "border border-[var(--yg-surface-2)] text-[var(--yg-text)]";

const message = (b: unknown) =>
  (b as { error?: { message?: string } })?.error?.message ?? "That did not work";

export function AddDocument({ lineItemId, canManage }: { lineItemId: string; canManage: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"FILE" | "LINK">("FILE");
  const [files, setFiles] = useState<Uploaded[]>([]);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [source, setSource] = useState("");
  const [quoted, setQuoted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canManage) return null;

  const ready = label.trim().length > 0 && (kind === "FILE" ? files.length > 0 : url.trim().length > 0);

  async function save() {
    setBusy(true);
    setError(null);

    let quotedPaise: number | undefined;
    if (quoted.trim()) {
      try {
        quotedPaise = rupeesToPaise(quoted);
      } catch {
        setBusy(false);
        setError("The quoted amount must be rupees, up to two decimals");
        return;
      }
    }

    // One call per file: a document is one thing with one label and one quoted
    // amount, and three photographs of the same quote are still three documents.
    const targets = kind === "FILE" ? files : [null];
    for (const [i, file] of targets.entries()) {
      const res = await fetch(`/api/v1/line-items/${lineItemId}/documents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind,
          ...(file ? { attachment_id: file.id } : { url: url.trim() }),
          label: targets.length > 1 ? `${label.trim()} (${i + 1})` : label.trim(),
          source_name: source.trim() || undefined,
          quoted_amount_paise: quotedPaise,
          purpose: kind === "LINK" ? "LISTING" : "QUOTE",
        }),
      });
      if (!res.ok) {
        setBusy(false);
        setError(message(await res.json().catch(() => null)));
        return;
      }
    }

    setBusy(false);
    setOpen(false);
    setFiles([]); setUrl(""); setLabel(""); setSource(""); setQuoted("");
    router.refresh();
  }

  if (!open) {
    return (
      <Button tone="ghost" className="mt-4" onClick={() => setOpen(true)}>
        <Plus size={16} aria-hidden /> Add a quote or listing
      </Button>
    );
  }

  return (
    <div
      className="mt-4 flex flex-col gap-3 rounded-[var(--r-card)] p-4"
      style={{ background: "var(--yg-bg-app)", border: "1px solid var(--yg-surface-2)" }}
    >
      <div className="flex gap-2" role="group" aria-label="Kind of document">
        {(["FILE", "LINK"] as const).map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={kind === k}
            onClick={() => setKind(k)}
            className="flex h-9 items-center gap-1.5 rounded-full px-4 text-[12.5px]"
            style={
              kind === k
                ? { background: "var(--yg-lime)", color: "var(--yg-on-accent)" }
                : { border: "1px solid var(--yg-surface-2)", color: "var(--yg-text-soft)" }
            }
          >
            {k === "LINK" && <Link2 size={13} aria-hidden />}
            {k === "FILE" ? "A file" : "A web listing"}
          </button>
        ))}
      </div>

      {kind === "FILE" ? (
        <FileUpload
          files={files}
          onChange={setFiles}
          purpose="QUOTE"
          label="Quotation or proforma invoice"
          hint="A photograph of a quote, a PDF invoice, a screenshot. JPG, PNG, HEIC or PDF, up to 10 MB each."
        />
      ) : (
        <label className="flex flex-col gap-1.5">
          <span className="meta-label">The page you are pricing from</span>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
            className={FIELD}
            inputMode="url"
          />
          <span className="text-[11.5px] text-text-muted">
            Listings change. Attach a screenshot as a second document if the price matters.
          </span>
        </label>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="meta-label">What it is</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Quotation — ABC Sound"
            className={FIELD}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="meta-label">Who from</span>
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="ABC Sound &amp; Lights"
            className={FIELD}
          />
        </label>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="meta-label">Amount quoted (₹) — optional</span>
        <input
          value={quoted}
          onChange={(e) => setQuoted(e.target.value)}
          inputMode="decimal"
          placeholder="19000"
          className={`${FIELD} text-right tabular-nums`}
        />
        <span className="text-[11.5px] text-text-muted">
          Filling this in is what lets Finance compare the planned amount against its cheapest quote.
        </span>
      </label>

      {error && <p className="text-[12px]" style={{ color: "var(--flag-high-fg)" }}>{error}</p>}

      <div className="flex gap-2.5">
        <Button tone="primary" disabled={busy || !ready} onClick={save}>
          {busy ? "Saving…" : "Add it"}
        </Button>
        <Button tone="ghost" onClick={() => { setOpen(false); setError(null); }}>Cancel</Button>
      </div>
    </div>
  );
}

/**
 * Removal is soft — the file is kept and marked removed, and it is logged (7.5).
 * A quote that was swapped out is exactly what the duplicate and lowest-quote rules
 * are about, so it is not the kind of thing to let disappear.
 */
export function RemoveDocument({
  lineItemId, attachmentId, name, canManage,
}: {
  lineItemId: string; attachmentId: string; name: string; canManage: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canManage) return null;

  async function remove() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/v1/line-items/${lineItemId}/documents/${attachmentId}`, {
      method: "DELETE",
    });
    setBusy(false);
    if (!res.ok) { setError(message(await res.json().catch(() => null))); return; }
    setConfirming(false);
    router.refresh();
  }

  return (
    <>
      <IconButton label={`Remove ${name}`} disabled={busy} onClick={() => setConfirming(true)}>
        <Trash2 size={15} aria-hidden />
      </IconButton>
      <ConfirmWithReason
        open={confirming}
        title={`Remove “${name}”?`}
        consequence={
          <>It stops counting toward this line item&rsquo;s supporting documents and toward the
            cheapest-quote comparison. The file itself is kept and the removal is recorded &mdash;
            a quote that was swapped out is exactly what an audit asks about.</>
        }
        confirmLabel="Remove it"
        cancelLabel="Keep it"
        tone="destructive"
        busy={busy}
        error={error}
        onConfirm={remove}
        onCancel={() => { setConfirming(false); setError(null); }}
      />
    </>
  );
}
