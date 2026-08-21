import { redirect } from "next/navigation";
import { clerkConfigured, devSignInCandidates, getSession } from "@/lib/session";

/**
 * The one screen allowed the landing treatment (PRD 9.1 rule 5): the fest's own
 * background, gradient nav and title artwork, so the hand-off from yugaantar.org
 * feels continuous. Everything inside the app stays restrained.
 */
export default async function SignInPage() {
  if (await getSession()) redirect("/dashboard");
  const candidates = await devSignInCandidates();

  return (
    <div className="min-h-screen" style={{ background: "var(--yg-bg)" }}>
      <div className="landing-nav h-1.5 w-full" />

      <main className="mx-auto flex max-w-lg flex-col items-center px-6 py-20">
        <p className="font-display text-sm tracking-[0.3em] text-lime uppercase">Yugaantar &rsquo;26</p>
        <h1
          className="font-display mt-4 text-center text-4xl leading-tight"
          style={{ color: "var(--yg-yellow-title)" }}
        >
          Finance &amp; Operations
        </h1>
        <p className="mt-4 text-center text-text-soft">
          Every rupee of the fest, and every ask between departments, in one place.
        </p>

        {clerkConfigured() ? (
          <a
            href="/sign-in/sso"
            className="mt-10 rounded-full px-6 py-3 font-medium"
            style={{ background: "var(--yg-yellow)", color: "var(--yg-on-accent)" }}
          >
            Continue with your college account
          </a>
        ) : (
          <section className="mt-10 w-full">
            <h2 className="text-sm font-medium text-text-muted">
              Development sign-in &mdash; Clerk is not configured yet
            </h2>
            <ul className="mt-3 divide-y" style={{ borderColor: "var(--yg-surface-2)" }}>
              {candidates.map((u) => (
                <li key={u.email}>
                  <form action="/api/dev/sign-in" method="post">
                    <input type="hidden" name="email" value={u.email} />
                    <button
                      type="submit"
                      className="flex w-full items-center justify-between px-3 py-3 text-left hover:bg-surface-2"
                    >
                      <span>
                        <span className="block text-text">{u.name}</span>
                        <span className="block text-xs text-text-muted">{u.email}</span>
                      </span>
                      <span className="text-xs text-lime">{u.department} &middot; {u.role.replace("_", " ")}</span>
                    </button>
                  </form>
                </li>
              ))}
            </ul>
            {candidates.length === 0 && (
              <p className="mt-3 rounded-lg bg-surface p-4 text-sm text-text-muted">
                No users found. Run <code className="text-lime">pnpm db:seed</code> first.
              </p>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
