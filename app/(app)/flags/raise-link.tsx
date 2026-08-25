"use client";

import { useState } from "react";
import { Flag } from "lucide-react";

/**
 * The flag screen is where you go when you *have* a concern, so it says where to
 * put one. Raising happens on the record itself rather than here, because a concern
 * without a subject is just a note — and picking the subject from a list of every
 * reimbursement in the fest would be worse than opening the one you meant.
 */
export function RaiseFlagLink({ allowed }: { allowed: boolean }) {
  const [open, setOpen] = useState(false);
  if (!allowed) return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-full px-4 py-2 text-sm"
        style={{ border: "1px solid var(--yg-surface-2)", color: "var(--yg-text-soft)" }}
      >
        <Flag size={14} aria-hidden /> Raise a concern
      </button>
      {open && (
        <div
          className="absolute right-0 z-20 mt-2 w-72 rounded-xl p-3 text-xs shadow-xl"
          style={{ background: "var(--yg-surface)", border: "1px solid var(--yg-surface-2)" }}
        >
          <p className="text-text-soft">Open the thing you are worried about and raise it there:</p>
          <ul className="mt-2 space-y-1 text-text-muted">
            <li>· a reimbursement or vendor request, from its page</li>
            <li>· a line item, from the budget screen</li>
            <li>· a department, from its budget page</li>
            <li>· a person, from Admin</li>
          </ul>
          <p className="mt-2 text-text-muted">
            It arrives here with whatever the rules found, and needs a note to clear either way.
          </p>
        </div>
      )}
    </div>
  );
}
