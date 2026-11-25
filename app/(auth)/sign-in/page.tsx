import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { allowedEmailDomains } from "@/lib/email-domains";
import { emailConfigured } from "@/lib/email";
import { SignInForm } from "./form";

export const dynamic = "force-dynamic";

/**
 * The one screen allowed the landing treatment (PRD 9.1 rule 5): the fest's own
 * background, gradient nav and title artwork, so the hand-off from yugaantar.org
 * feels continuous. Everything inside the app stays restrained.
 *
 * The way in is an emailed one-time link (see `lib/auth.ts`), and it follows an
 * invitation — nobody signs themselves up.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await getSession()) redirect("/dashboard");

  const domains = allowedEmailDomains();
  const { error } = await searchParams;

  return (
    <div className="min-h-screen" style={{ background: "var(--yg-bg)" }}>
      <div className="landing-nav h-1.5 w-full" />

      <main className="mx-auto flex max-w-md flex-col items-center px-6 py-16 sm:py-20">
        <p className="font-display text-sm tracking-[0.3em] text-accent uppercase">Yugaantar &rsquo;26</p>
        {/* Plain, and smaller. A coloured 36px wordmark was the loudest thing in
            the product on the one screen that is nobody's destination. */}
        <h1 className="mt-3 text-center text-[26px] leading-tight font-semibold">
          Finance &amp; Operations
        </h1>
        <p className="mt-4 text-center text-text-soft">
          Every rupee of the fest, and every ask between departments, in one place.
        </p>

        {error === "link" && (
          <p
            className="mt-8 w-full rounded-lg px-4 py-3 text-sm"
            style={{ background: "var(--yg-surface)", border: "1px solid var(--flag-high-fg)", color: "var(--yg-text-soft)" }}
          >
            That sign-in link has expired or was already used. Ask for a new one below.
          </p>
        )}

        <SignInForm domains={domains} deliversEmail={emailConfigured()} />
      </main>
    </div>
  );
}
