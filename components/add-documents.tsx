"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui";
import { ConfirmWithReason, Spinner } from "@/components/confirm";
import { FileUpload, type Uploaded } from "@/components/file-upload";

/**
 * "Add documents" on a record that already exists — a vendor request or a vendor.
 *
 * The files upload as they are picked (presign → PUT → complete); nothing is bound
 * to the record until "Add" is pressed, which sends them with what kind of document
 * they are. Anything picked and abandoned is unbound, and the nightly sweep
 * collects it.
 */
export function AddDocuments({
  endpoint, kinds, max = 10, hint,
}: {
  endpoint: string;
  kinds: { value: string; label: string }[];
  max?: number;
  hint?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState(kinds[0].value);
  const [files, setFiles] = useState<Uploaded[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <Button tone="ghost" className="mt-3" onClick={() => setOpen(true)}>
        <Paperclip size={15} aria-hidden /> Add documents
      </Button>
    );
  }

  async function add() {
    setBusy(true);
    setError(null);
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ attachment_ids: files.map((f) => f.id), kind }),
    });
    const json = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      setError(json?.error?.message ?? "Those files could not be added");
      return;
    }
    setFiles([]);
    setOpen(false);
    router.refresh();
  }

  return (
    <div
      className={`mt-3 flex flex-col gap-3 rounded-[var(--r-card)] p-3.5 ${busy ? "is-pending" : ""}`}
      style={{ background: "var(--yg-bg-app)", border: "1px solid var(--yg-surface-2)" }}
    >
      <label className="flex flex-col gap-1.5">
        <span className="meta-label">What is it?</span>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className="rounded-[var(--r-control)] px-3 py-2.5 text-[13.5px] bg-[var(--yg-surface)] border border-[var(--yg-surface-2)] text-[var(--yg-text)]"
        >
          {kinds.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
      </label>

      <FileUpload files={files} onChange={setFiles} max={max} purpose="OTHER" label="Files" hint={hint} />

      {error && <p className="text-[12px]" style={{ color: "var(--flag-high-fg)" }}>{error}</p>}

      <div className="flex flex-wrap gap-2.5">
        <Button tone="hero" disabled={busy || files.length === 0} onClick={add}>
          {busy && <Spinner />}
          {busy ? "Adding…" : files.length > 1 ? `Add ${files.length} documents` : "Add document"}
        </Button>
        <Button tone="ghost" onClick={() => { setOpen(false); setFiles([]); setError(null); }}>Cancel</Button>
      </div>
    </div>
  );
}

/** Removing a document — the vendor's own papers, which Finance keeps current. */
export function RemoveDocument({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/v1/attachments/${id}`, { method: "DELETE" });
    const json = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      setError(json?.error?.message ?? "That file could not be removed");
      return;
    }
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="tap ml-1 inline-flex items-center text-text-muted hover:text-text"
        aria-label={`Remove ${name}`}
      >
        <X size={14} aria-hidden />
      </button>
      <ConfirmWithReason
        open={open}
        title="Remove this document?"
        consequence={<>{name} comes off this vendor. The removal is recorded in the audit log.</>}
        confirmLabel="Remove"
        cancelLabel="Keep it"
        tone="destructive"
        busy={busy}
        error={error}
        onConfirm={remove}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}
