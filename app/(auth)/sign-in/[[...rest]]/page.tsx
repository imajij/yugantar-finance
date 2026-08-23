import { redirect } from "next/navigation";
import { SignIn } from "@clerk/nextjs";
import { clerkConfigured, devSignInCandidates, getSession } from "@/lib/session";

/**
 * The one screen allowed the landing treatment (PRD 9.1 rule 5): the fest's own
 * background, gradient nav and title artwork, so the hand-off from yugaantar.org
 * feels continuous. Everything inside the app stays restrained.
 */
export default async function SignInPage() {
  if (await getSession()) redirect("/dashboard");
  const candidates = await devSignInCandidates();
  // No Clerk and no dev fallback means there is no way in at all (see `lib/session.ts`).
  const misconfigured = !clerkConfigured() && process.env.NODE_ENV === "production";

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
          <div className="mt-10">
            <SignIn
              routing="path"
              path="/sign-in"
              fallbackRedirectUrl="/dashboard"
              appearance={{
                variables: {
                  colorBackground: "#14140f",
                  colorPrimary: "#c3f53c",
                  colorForeground: "#f2f2ec",
                  colorInput: "#1d1d17",
                  borderRadius: "0.6rem",
                },
              }}
            />
            <p className="mt-4 text-center text-xs text-text-muted">
              Use your @{process.env.ALLOWED_EMAIL_DOMAIN ?? "college"} account. External
              Management users sign in with the address they were invited on.
            </p>
          </div>
        ) : misconfigured ? (
          /*
           * Fail closed, and say so. Without Clerk there is no way into a production
           * deployment — which is the correct behaviour, but silence here would look
           * like a broken app rather than a missing environment variable.
           */
          <section
            className="mt-10 w-full rounded-xl p-5 text-sm"
            style={{ background: "var(--yg-surface)", border: "1px solid var(--yg-surface-2)" }}
          >
            <p className="text-text">Sign-in is not available.</p>
            <p className="mt-2 text-text-muted">
              This deployment has no identity provider configured, so nobody can sign in.
              Set <code className="text-lime">CLERK_SECRET_KEY</code> and{" "}
              <code className="text-lime">NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY</code>, then redeploy.
            </p>
          </section>
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
