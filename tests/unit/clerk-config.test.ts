/**
 * "Is Clerk configured?" is answered in two places, and they have to agree.
 *
 * `lib/clerk.ts` decides whether the app calls `auth()`; `proxy.ts` decides whether
 * `clerkMiddleware()` runs. Proxy code cannot import shared modules — Next may deploy
 * it to the CDN edge — so the rule is written twice, and drift between the two copies
 * is not a style problem but an outage: if the app says yes where the proxy says no,
 * `auth()` throws "clerkMiddleware() was not run" on *every* page, including the
 * sign-in screen, and nobody can get in to fix it.
 *
 * That is exactly what a deployment with only `CLERK_SECRET_KEY` set did.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { CLERK_KEYS, clerkConfigured } from "@/lib/clerk";

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of CLERK_KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of CLERK_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

const set = (values: Partial<Record<(typeof CLERK_KEYS)[number], string>>) => {
  for (const k of CLERK_KEYS) {
    if (values[k] === undefined) delete process.env[k];
    else process.env[k] = values[k]!;
  }
};

test("both keys means Clerk is on", () => {
  set({ CLERK_SECRET_KEY: "sk_test", NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test" });
  expect(clerkConfigured()).toBe(true);
});

test("neither key means Clerk is off", () => {
  set({});
  expect(clerkConfigured()).toBe(false);
});

test("the secret alone is not enough — this is what 500ed a deployment", () => {
  set({ CLERK_SECRET_KEY: "sk_test" });
  expect(clerkConfigured()).toBe(false);
});

test("the publishable key alone is not enough either", () => {
  set({ NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test" });
  expect(clerkConfigured()).toBe(false);
});

test("blank counts as unset, so a copied .env.example does not half-enable Clerk", () => {
  set({ CLERK_SECRET_KEY: "sk_test", NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "   " });
  expect(clerkConfigured()).toBe(false);
});

test("proxy.ts requires the same keys as lib/clerk.ts", () => {
  // Read rather than import: proxy.ts is a Next entrypoint, not a module to call.
  const proxy = readFileSync("proxy.ts", "utf8");

  const declared = /const CLERK_KEYS = \[([^\]]*)\]/.exec(proxy);
  expect(declared, "proxy.ts should declare CLERK_KEYS").not.toBeNull();

  const proxyKeys = [...declared![1].matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]);
  expect(proxyKeys.sort()).toEqual([...CLERK_KEYS].sort());

  // And it must require every one of them, not merely mention them.
  expect(proxy).toMatch(/CLERK_KEYS\.every\(/);
});
