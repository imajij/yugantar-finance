"use client";

import { useState } from "react";
import { Mail } from "lucide-react";

const INPUT =
  "w-full rounded-lg px-3.5 py-2.5 text-sm bg-[var(--yg-bg)] border border-[var(--yg-surface-2)] "
  + "text-[var(--yg-text)] placeholder:text-[var(--yg-text-muted)] focus:outline-none "
  + "focus:border-[var(--yg-lime)]";

/**
 * Ask for a sign-in link.
 *
 * The confirmation is deliberately the same whether or not the address exists — the
 * endpoint behaves that way and the screen must not undo it, or the form becomes a
 * way to ask who is on the finance committee. So there is no "we don't know that
 * address" state here, by design.
 */
export function SignInForm({
  domain,
  deliversEmail,
}: {
  domain: string | null;
  deliversEmail: boolean;
}) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setState("sending");
    setError(null);

    try {
      const res = await fetch("/api/v1/auth/request-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        // Rate limiting is the only failure worth surfacing; everything else is
        // answered identically on purpose.
        setError(body?.error?.message ?? "Could not send a link just now. Try again shortly.");
        setState("idle");
        return;
      }
      setState("sent");
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
      setState("idle");
    }
  }

  if (state === "sent") {
    return (
      <section
        className="mt-10 w-full rounded-xl p-6 text-center"
        style={{ background: "var(--yg-surface)", border: "1px solid var(--yg-surface-2)" }}
      >
        <Mail size={22} aria-hidden className="mx-auto text-lime" />
        <h2 className="mt-3 text-sm font-medium text-text">Check your inbox</h2>
        <p className="mt-2 text-sm text-text-muted">
          If <span className="text-text-soft">{email}</span> has been invited to this fest, a
          sign-in link is on its way. It works once and expires in 15 minutes.
        </p>
        {!deliversEmail && (
          <p className="mt-3 rounded-lg p-3 text-xs text-text-muted" style={{ background: "var(--yg-bg)" }}>
            No mail provider is configured on this deployment, so the link was written to the
            server log instead. Set <code className="text-lime">RESEND_API_KEY</code> to send it
            for real.
          </p>
        )}
        <button
          type="button"
          onClick={() => setState("idle")}
          className="mt-4 text-sm"
          style={{ color: "var(--yg-pink)" }}
        >
          Use a different address
        </button>
      </section>
    );
  }

  return (
    <form onSubmit={submit} className="mt-10 w-full">
      <label htmlFor="email" className="block text-sm text-text-soft">
        Email
      </label>
      <input
        id="email"
        name="email"
        type="email"
        required
        autoFocus
        autoComplete="email"
        inputMode="email"
        placeholder={domain ? `you@${domain}` : "you@college.edu"}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className={`mt-1.5 ${INPUT}`}
      />

      <button
        type="submit"
        disabled={state === "sending" || email.trim().length < 5}
        className="mt-4 w-full rounded-lg px-4 py-2.5 text-sm font-medium disabled:opacity-40"
        style={{ background: "var(--yg-yellow)", color: "var(--yg-on-accent)" }}
      >
        {state === "sending" ? "Sending…" : "Email me a sign-in link"}
      </button>

      {error && (
        <p className="mt-3 text-sm" style={{ color: "var(--flag-high-fg)" }}>
          {error}
        </p>
      )}

      <p className="mt-5 text-center text-xs text-text-muted">
        Only {domain ? `@${domain}` : "college"} accounts that have been invited can sign in.
        Ask the Finance HOD for an invitation.
      </p>
    </form>
  );
}
