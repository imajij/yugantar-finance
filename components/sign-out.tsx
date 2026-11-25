"use client";

import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";

const CLASS =
  "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-text-muted hover:bg-surface-2 hover:text-text";

/**
 * Revokes the session row. A POST rather than a link because it changes state — and
 * it revokes server-side, so clearing the cookie is not the only thing standing
 * between a copied cookie and an account.
 */
export function SignOutButton() {
  const router = useRouter();

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
