"use client";

import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { SignOutButton as ClerkSignOutButton } from "@clerk/nextjs";

const CLASS =
  "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-text-muted hover:bg-surface-2 hover:text-text";

/**
 * Two sign-outs behind one control: Clerk's when it is wired, and clearing the dev
 * cookie when it is not. The dev path exists only so the app is demoable before auth
 * lands (see `lib/session.ts`); it is inert in production.
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
        await fetch("/api/dev/sign-in", { method: "DELETE" });
        router.replace("/sign-in");
        router.refresh();
      }}
    >
      <LogOut size={13} aria-hidden />
      Sign out
    </button>
  );
}
