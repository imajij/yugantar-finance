"use client";

import { useState } from "react";
import { FileText, Loader2, Paperclip, X } from "lucide-react";

/**
 * Optional file attachment, before the record it belongs to exists.
 *
 * The upload is three calls (PRD 20.2): ask for a presigned URL, PUT the bytes
 * straight to storage so they never pass through the app, then confirm — which is
 * where the server hashes the file for the duplicate-receipt rule. What comes back
 * is an attachment id belonging to whoever uploaded it and bound to nothing.
 *
 * That last part is what makes this work on a *create* form. An unbound attachment
 * is visible only to its uploader, so a file can be sitting in storage while the
 * line item it will hang off is still a half-filled form — and if the form is
 * abandoned, the file is never bound to anything and the nightly sweep collects it.
 */

export interface Uploaded { id: string; name: string; sizeBytes: number }

const ACCEPT = "image/jpeg,image/png,image/heic,image/heif,image/webp,application/pdf";
const MAX_BYTES = 10 * 1024 * 1024;

const readable = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export function FileUpload({
  files, onChange, max = 10, purpose = "QUOTE", label, hint,
}: {
  files: Uploaded[];
  onChange: (next: Uploaded[]) => void;
  /** PRD 7.1: ten per line item, five per request. */
  max?: number;
  purpose?: "QUOTE" | "LISTING" | "RECEIPT" | "OTHER";
  label: string;
  hint?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const room = max - files.length;

  async function add(picked: FileList | null) {
    if (!picked?.length) return;
    setBusy(true);
    setError(null);

    const accepted: Uploaded[] = [];
    try {
      for (const file of Array.from(picked).slice(0, room)) {
        // Checked here as well as on the server, so a 9 MB photograph fails before
        // it is uploaded rather than after.
        if (file.size > MAX_BYTES) {
          throw new Error(`${file.name} is ${readable(file.size)} — the limit is 10 MB`);
        }

        const presign = await post("/api/v1/attachments/presign", {
          purpose,
          file_name: file.name,
          mime_type: file.type || "application/octet-stream",
          size_bytes: file.size,
        });

        const put = await fetch(presign.upload_url, { method: "PUT", body: file });
        if (!put.ok) throw new Error(`${file.name} did not upload — try again when the signal is better`);

        await post(`/api/v1/attachments/${presign.attachment_id}/complete`, {});
        accepted.push({ id: presign.attachment_id, name: file.name, sizeBytes: file.size });
      }
      onChange([...files, ...accepted]);
    } catch (e) {
      // Whatever did land is kept: making somebody re-pick four files because the
      // fifth failed is the wrong way round.
      if (accepted.length) onChange([...files, ...accepted]);
      setError(e instanceof Error ? e.message : "That upload did not work");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="meta-label">{label}</span>
        <span className="text-[11px] text-text-muted">optional</span>
      </div>

      {files.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {files.map((f) => (
            <li
              key={f.id}
              className="flex items-center gap-2.5 rounded-[var(--r-control)] px-3 py-2"
              style={{ background: "var(--yg-surface)", border: "1px solid var(--yg-surface-2)" }}
            >
              <FileText size={15} className="shrink-0 text-text-muted" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-[13px]">{f.name}</span>
              <span className="tnum shrink-0 text-[11.5px] text-text-muted">{readable(f.sizeBytes)}</span>
              <button
                type="button"
                onClick={() => onChange(files.filter((x) => x.id !== f.id))}
                aria-label={`Remove ${f.name}`}
                className="tap shrink-0 text-text-muted hover:text-text"
              >
                <X size={15} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      {room > 0 && (
        <label
          className="flex h-[var(--row-h)] cursor-pointer items-center justify-center gap-2 rounded-[var(--r-control)] text-[13px]"
          style={{ border: "1px dashed var(--yg-surface-2)", color: "var(--yg-text-soft)" }}
        >
          {busy ? <Loader2 size={15} className="yg-spin" aria-hidden /> : <Paperclip size={15} aria-hidden />}
          {busy ? "Uploading…" : files.length > 0 ? "Add another" : "Attach a file"}
          <input
            type="file"
            multiple
            className="sr-only"
            accept={ACCEPT}
            disabled={busy}
            onChange={(e) => { add(e.target.files); e.target.value = ""; }}
          />
        </label>
      )}

      {error && <p className="text-[12px]" style={{ color: "var(--flag-high-fg)" }}>{error}</p>}

      <p className="text-[11.5px] leading-relaxed text-text-muted">
        {hint ?? "JPG, PNG, HEIC or PDF, up to 10 MB each."}
        {room > 0 ? ` ${room} more can be added.` : " That is the maximum."}
      </p>
    </div>
  );
}

async function post(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error?.message ?? `Request failed (${res.status})`);
  return json;
}
