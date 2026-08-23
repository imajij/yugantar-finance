"use client";

import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { SignOutButton as ClerkSignOutButton } from "@clerk/nextjs";

const CLASS =
  "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-text-muted hover:bg-surface-2 hover:text-text";

/**
 * Two sign-outs behind one control, matching the two ways in (`lib/session.ts`):
 * Clerk's when it is wired, and revoking the session row when it is not. The second
 * is a POST rather than a link because it changes state — and it revokes server-side,
 * so clearing the cookie is not the only thing standing between a copied cookie and
 * an account.
 */
export function SignOutButton({ withClerk }: { withClerk: boolean }) {
  const router = useRouter();

  if (withClerk) {
    return (
      <ClerkSignOutButton redirectUrl="/sign-in">
        <button type="button" className={CLASS}>
          <LogOut size={13} aria-hidden />
          Sign out
        </button>
      </ClerkSignOutButton>
    );
  }

  return (
    <button
      type="button"
      className={CLASS}
      onClick={async () => {
        await fetch("/api/v1/auth/sign-out", { method: "POST" });
        router.replace("/sign-in");
        router.refresh();
      }}
    >
      <LogOut size={13} aria-hidden />
      Sign out
    </button>
  );
}
