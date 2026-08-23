"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function MarkAllRead() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await fetch("/api/v1/notifications/read", {
          method: "POST", headers: { "content-type": "application/json" }, body: "{}",
        });
        setBusy(false);
        router.refresh();
      }}
      className="rounded-full px-4 py-2 text-sm disabled:opacity-50"
      style={{ border: "1px solid var(--yg-surface-2)", color: "var(--yg-text-soft)" }}
    >
      {busy ? "…" : "Mark all read"}
    </button>
  );
}
