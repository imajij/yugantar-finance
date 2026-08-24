"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatPaise } from "@/lib/money";

const INPUT = "rounded-lg px-3 py-2 text-sm bg-[var(--yg-bg-app)] border border-[var(--yg-surface-2)] text-[var(--yg-text)]";
const ROLES = ["MEMBER", "DEPT_HOD", "FINANCE_HOD", "MANAGEMENT"] as const;

function useSave() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(url: string, method: "POST" | "PATCH", body: unknown) {
    setBusy(true);
    setError(null);
    const res = await fetch(url, {
      method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      setError(json?.error?.message ?? "That did not work");
      return false;
    }
    router.refresh();
    return true;
  }
  return { save, busy, error };
}

interface Person {
  id: string; name: string; email: string; role: string;
  status: string; department: string; departmentId: string; isSuperAdmin: boolean;
}

export function People({
  users, departments, meId, canManageAdmins,
}: {
  users: Person[];
  departments: { id: string; name: string }[];
  meId: string;
  /** Only an administrator may appoint one, so only they see the control. */
  canManageAdmins: boolean;
}) {
  const { save, busy, error } = useSave();
  const [adding, setAdding] = useState(false);

  return (
    <>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-text-muted">
              <th className="pb-2 font-medium">Name</th>
              <th className="pb-2 font-medium">Role</th>
              <th className="pb-2 font-medium">Department</th>
              {canManageAdmins && <th className="pb-2 font-medium">Admin</th>}
              <th className="pb-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} style={{ borderTop: "1px solid var(--yg-surface-2)" }}>
                <td className="py-2">
                  {u.name}
                  <p className="text-xs text-text-muted">{u.email}</p>
                </td>
                <td className="py-2">
                  <select
                    defaultValue={u.role} disabled={busy || u.id === meId} className={INPUT}
                    onChange={(e) => save(`/api/v1/users/${u.id}`, "PATCH", { role: e.target.value })}
                  >
                    {ROLES.map((r) => <option key={r} value={r}>{r.replace("_", " ").toLowerCase()}</option>)}
                  </select>
                </td>
                <td className="py-2">
                  <select
                    defaultValue={u.departmentId} disabled={busy} className={INPUT}
                    onChange={(e) => save(`/api/v1/users/${u.id}`, "PATCH", { department_id: e.target.value })}
                  >
                    {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                </td>
                {canManageAdmins && (
                  <td className="py-2">
                    <label className="flex items-center gap-1.5 text-xs text-text-muted">
                      <input
                        type="checkbox"
                        defaultChecked={u.isSuperAdmin}
                        disabled={busy}
                        onChange={(e) =>
                          save(`/api/v1/users/${u.id}`, "PATCH", { is_super_admin: e.target.checked })}
                      />
                      {u.isSuperAdmin ? "admin" : ""}
                    </label>
                  </td>
                )}
                <td className="py-2">
                  {u.id === meId ? (
                    <span className="text-xs text-text-muted">you</span>
                  ) : (
                    <button
                      disabled={busy}
                      onClick={() => save(`/api/v1/users/${u.id}`, "PATCH", {
                        status: u.status === "DISABLED" ? "ACTIVE" : "DISABLED",
                      })}
                      className="rounded-full px-3 py-1 text-xs"
                      style={{ border: "1px solid var(--yg-surface-2)", color: "var(--yg-text-soft)" }}
                    >
                      {u.status === "DISABLED" ? "Reactivate" : u.status.toLowerCase()}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {adding ? (
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const ok = await save("/api/v1/users", "POST", {
              name: f.get("name"), email: f.get("email"),
              role: f.get("role"), department_id: f.get("department_id"),
              is_super_admin: f.get("is_super_admin") === "on",
            });
            if (ok) setAdding(false);
          }}
        >
          <input name="name" required placeholder="Name" minLength={2} className={INPUT} />
          <input name="email" required type="email" placeholder="email@sst.scaler.com" className={INPUT} />
          <select name="role" defaultValue="MEMBER" className={INPUT}>
            {ROLES.map((r) => <option key={r} value={r}>{r.replace("_", " ").toLowerCase()}</option>)}
          </select>
          <select name="department_id" required defaultValue="" className={INPUT}>
            <option value="" disabled>Department</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          {canManageAdmins && (
            <label className="flex items-center gap-1.5 pb-2 text-xs text-text-soft">
              <input type="checkbox" name="is_super_admin" />
              Administrator
            </label>
          )}
          <button type="submit" disabled={busy}
            className="rounded-full px-4 py-2 text-sm font-medium disabled:opacity-50"
            style={{ background: "var(--yg-lime)", color: "var(--yg-on-accent)" }}>
            Invite
          </button>
        </form>
      ) : (
        <button onClick={() => setAdding(true)} className="mt-3 text-sm" style={{ color: "var(--yg-pink)" }}>
          + Invite someone
        </button>
      )}

      {error && <p className="mt-2 text-sm" style={{ color: "var(--flag-high-fg)" }}>{error}</p>}
    </>
  );
}

export function ExpenseTypes({ types }: { types: { id: string; name: string; isActive: boolean }[] }) {
  const { save, busy, error } = useSave();

  return (
    <>
      <ul className="mt-3 space-y-1 text-sm">
        {types.map((t) => (
          <li key={t.id} className="flex items-center justify-between gap-3">
            <span className={t.isActive ? "" : "text-text-muted line-through"}>{t.name}</span>
            <button
              disabled={busy}
              onClick={() => save(`/api/v1/expense-types/${t.id}`, "PATCH", { is_active: !t.isActive })}
              className="rounded-full px-3 py-1 text-xs"
              style={{ border: "1px solid var(--yg-surface-2)", color: "var(--yg-text-soft)" }}
            >
              {t.isActive ? "Retire" : "Restore"}
            </button>
          </li>
        ))}
      </ul>

      <form
        className="mt-3 flex flex-wrap gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const f = new FormData(form);
          if (await save("/api/v1/expense-types", "POST", { name: f.get("name") })) form.reset();
        }}
      >
        <input name="name" required minLength={2} maxLength={80} placeholder="New expense type" className={INPUT} />
        <button type="submit" disabled={busy}
          className="rounded-full px-4 py-2 text-sm disabled:opacity-50"
          style={{ border: "1px solid var(--yg-surface-2)", color: "var(--yg-text-soft)" }}>
          Add
        </button>
      </form>

      {error && <p className="mt-2 text-sm" style={{ color: "var(--flag-high-fg)" }}>{error}</p>}
    </>
  );
}

/** Amount dials are stored in paise; the form works in rupees (18.2 rule 4). */
const DIALS: { key: string; label: string; unit: "paise" | "pct" | "days" | "count" | "x" }[] = [
  { key: "F2_abs_paise", label: "F2 — receipt/amount gap tolerated", unit: "paise" },
  { key: "F2_pct", label: "F2 — or this much of the amount", unit: "pct" },
  { key: "F4_before_days", label: "F4 — days before the fest still in window", unit: "days" },
  { key: "F4_after_days", label: "F4 — days after", unit: "days" },
  { key: "F6_count", label: "F6 — payee repeats before flagging", unit: "count" },
  { key: "F6_total_paise", label: "F6 — or total to the same payee", unit: "paise" },
  { key: "F8_pct", label: "F8 — advance above this share of the contract", unit: "pct" },
  { key: "F10_threshold_paise", label: "F10 — single spend considered large", unit: "paise" },
  { key: "F11_multiplier", label: "F11 — times the usual price", unit: "x" },
  { key: "F11_min_samples", label: "F11 — samples before comparing", unit: "count" },
  { key: "F14_pct", label: "F14 — spend above the quote", unit: "pct" },
  { key: "income_followup_days", label: "Income — days before chasing a pledge", unit: "days" },
];

export function Thresholds({ values }: { values: Record<string, number> }) {
  const { save, busy, error } = useSave();

  return (
    <form
      className="mt-3"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const patch: Record<string, number> = {};
        for (const { key, unit } of DIALS) {
          const raw = Number(f.get(key));
          if (Number.isFinite(raw)) patch[key] = unit === "paise" ? Math.round(raw * 100) : raw;
        }
        save("/api/v1/fest/settings", "PATCH", { flag_thresholds: patch });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {DIALS.map(({ key, label, unit }) => (
          <div key={key}>
            <label htmlFor={key} className="text-xs text-text-muted">{label}</label>
            <div className="mt-1 flex items-center gap-2">
              <input
                id={key} name={key}
                type="number"
                step={unit === "paise" ? "0.01" : unit === "x" ? "0.1" : "1"}
                min="0"
                defaultValue={unit === "paise" ? (values[key] ?? 0) / 100 : values[key] ?? 0}
                className={`${INPUT} w-full`}
              />
              <span className="text-xs text-text-muted">
                {unit === "paise" ? "₹" : unit === "pct" ? "%" : unit === "x" ? "×" : unit}
              </span>
            </div>
            {unit === "paise" && (
              <p className="tnum mt-0.5 text-xs text-text-muted">now {formatPaise(values[key] ?? 0)}</p>
            )}
          </div>
        ))}
      </div>

      <button type="submit" disabled={busy}
        className="mt-4 rounded-full px-4 py-2 text-sm font-medium disabled:opacity-50"
        style={{ background: "var(--yg-lime)", color: "var(--yg-on-accent)" }}>
        {busy ? "Saving…" : "Save thresholds"}
      </button>

      {error && <p className="mt-2 text-sm" style={{ color: "var(--flag-high-fg)" }}>{error}</p>}
    </form>
  );
}

/* -------------------------------------------------------------- departments */

interface Dept {
  id: string;
  name: string;
  slug: string;
  kind: string;
  allocatedPaise: number;
  isActive: boolean;
  openRecords: number;
}

/** A slug is derived, not typed: one less thing to get wrong, still editable. */
const slugify = (name: string) =>
  name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

/**
 * Departments (PRD 20.4).
 *
 * Allocation is deliberately not editable here. Money only ever moves through a
 * budget transfer, so that every rupee that changes hands has a reason and an audit
 * row (7.1) — this screen links to that one rather than reproducing it.
 *
 * Finance and Core are shown but not editable: the schema permits exactly one of
 * each per fest, and they are what the roles hang off.
 */
export function Departments({ departments }: { departments: Dept[] }) {
  const { save, busy, error } = useSave();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");

  const budgetDepts = departments.filter((d) => d.kind === "BUDGET");

  return (
    <>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-text-muted">
              <th className="pb-2 font-medium">Department</th>
              <th className="pb-2 font-medium">Kind</th>
              <th className="pb-2 pr-0 text-right font-medium">Allocated</th>
              <th className="pb-2 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {departments.map((d) => (
              <tr key={d.id} style={{ borderTop: "1px solid var(--yg-surface-2)" }}>
                <td className="py-2">
                  {d.kind === "BUDGET" ? (
                    <input
                      defaultValue={d.name}
                      disabled={busy}
                      className={INPUT}
                      onBlur={(e) => {
                        const next = e.target.value.trim();
                        if (next && next !== d.name) save(`/api/v1/departments/${d.id}`, "PATCH", { name: next });
                      }}
                    />
                  ) : (
                    <span>{d.name}</span>
                  )}
                  <p className="mt-0.5 text-xs text-text-muted">{d.slug}</p>
                </td>
                <td className="py-2 text-xs text-text-muted">{d.kind.toLowerCase()}</td>
                <td className="tnum py-2 text-right">{formatPaise(d.allocatedPaise)}</td>
                <td className="py-2 text-right">
                  {d.kind === "BUDGET" && (
                    <button
                      disabled={busy}
                      onClick={() => save(`/api/v1/departments/${d.id}`, "PATCH", { is_active: !d.isActive })}
                      className="rounded-full px-3 py-1 text-xs"
                      style={{ border: "1px solid var(--yg-surface-2)", color: "var(--yg-text-soft)" }}
                      title={
                        d.isActive && (d.openRecords > 0 || d.allocatedPaise > 0)
                          ? "Close its open records and move its allocation back to Reserve first"
                          : undefined
                      }
                    >
                      {d.isActive ? "Deactivate" : "Reactivate"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {adding ? (
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const ok = await save("/api/v1/departments", "POST", {
              name: f.get("name"),
              slug: f.get("slug"),
              allocated_paise: 0,
            });
            if (ok) { setAdding(false); setName(""); }
          }}
        >
          <input
            name="name" required minLength={2} placeholder="Department name" className={INPUT}
            value={name} onChange={(e) => setName(e.target.value)} autoFocus
          />
          <input
            name="slug" required pattern="[a-z0-9\-]+" placeholder="slug" className={INPUT}
            key={slugify(name)} defaultValue={slugify(name)}
          />
          <button type="submit" disabled={busy}
            className="rounded-full px-4 py-2 text-sm font-medium disabled:opacity-50"
            style={{ background: "var(--yg-lime)", color: "var(--yg-on-accent)" }}>
            Add department
          </button>
          <button type="button" onClick={() => setAdding(false)} className="text-sm text-text-muted">
            Cancel
          </button>
        </form>
      ) : (
        <button onClick={() => setAdding(true)} className="mt-3 text-sm" style={{ color: "var(--yg-pink)" }}>
          + Add a department
        </button>
      )}

      <p className="mt-3 text-xs text-text-muted">
        New departments start with nothing allocated. Move money to them from Reserve on the{" "}
        <Link href="/budget" style={{ color: "var(--yg-pink)" }}>budget screen</Link> — every transfer
        carries a reason and is logged.
        {budgetDepts.length === 0 && " Add your first department to get started."}
      </p>

      {error && <p className="mt-2 text-sm" style={{ color: "var(--flag-high-fg)" }}>{error}</p>}
    </>
  );
}

/* ------------------------------------------------------------- fest budget */

/**
 * The fest total (PRD 20.4). It cannot drop below what is already allocated, and the
 * API refuses if it would — the message says by how much.
 */
export function FestBudget({
  totalBudgetPaise, allocatedPaise,
}: { totalBudgetPaise: number; allocatedPaise: number }) {
  const { save, busy, error } = useSave();
  const [value, setValue] = useState(String(totalBudgetPaise / 100));

  const rupees = Number(value);
  const changed = Number.isFinite(rupees) && Math.round(rupees * 100) !== totalBudgetPaise;

  return (
    <>
      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          await save("/api/v1/fest", "PATCH", {
            total_budget_paise: Math.round(Number(f.get("total")) * 100),
            reason: String(f.get("reason") || "Fest total set from admin"),
          });
        }}
      >
        <label className="text-xs text-text-muted">
          Total budget (₹)
          <input
            name="total" type="number" min={0} step="0.01" required className={`mt-1 block ${INPUT}`}
            value={value} onChange={(e) => setValue(e.target.value)}
          />
        </label>
        <label className="min-w-56 flex-1 text-xs text-text-muted">
          Reason
          <input name="reason" required minLength={3} placeholder="Sanctioned by the college"
            className={`mt-1 block w-full ${INPUT}`} />
        </label>
        <button type="submit" disabled={busy || !changed}
          className="rounded-full px-4 py-2 text-sm font-medium disabled:opacity-40"
          style={{ background: "var(--yg-yellow)", color: "var(--yg-on-accent)" }}>
          Save
        </button>
      </form>

      <p className="mt-2 text-xs text-text-muted">
        {formatPaise(allocatedPaise)} is allocated to departments, so the total cannot go below
        that. The remainder is Reserve, held by Finance.
      </p>

      {error && <p className="mt-2 text-sm" style={{ color: "var(--flag-high-fg)" }}>{error}</p>}
    </>
  );
}
