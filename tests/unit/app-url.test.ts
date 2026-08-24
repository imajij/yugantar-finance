/**
 * The origin emailed links are built on (`appUrl` in `lib/email.tsx`).
 *
 * Two failures it has to prevent, and they pull in opposite directions:
 *
 *   - A production deployment whose `APP_URL` still says `localhost` emails links to
 *     the recipient's own machine. The mail sends, the provider reports it delivered,
 *     and the link is dead — the quietest possible failure. This happened.
 *   - Deriving the origin from the request's `Host` header would fix that and open
 *     password-reset poisoning: one request with a forged `Host` and the next
 *     one-time sign-in token points at somebody else's server. So the fallback is
 *     the platform's own variable, which the caller cannot set.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { appUrl } from "@/lib/email";

const KEYS = ["APP_URL", "VERCEL_PROJECT_PRODUCTION_URL", "VERCEL_URL", "NODE_ENV"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else (process.env as Record<string, string>)[k] = saved[k]!;
  }
});

function environment(values: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) {
    if (values[k] === undefined) delete process.env[k];
    else (process.env as Record<string, string>)[k] = values[k]!;
  }
}

test("an explicit APP_URL wins, so a custom domain is used over the platform's", () => {
  environment({
    APP_URL: "https://yugantar.ajij.dev",
    VERCEL_PROJECT_PRODUCTION_URL: "yugantar-finance.vercel.app",
    NODE_ENV: "production",
  });
  expect(appUrl()).toBe("https://yugantar.ajij.dev");
});

test("a trailing slash is trimmed, so links do not end up with a double slash", () => {
  environment({ APP_URL: "https://yugantar.ajij.dev/" });
  expect(appUrl()).toBe("https://yugantar.ajij.dev");
});

test("localhost in production loses to the platform's own URL", () => {
  environment({
    APP_URL: "http://localhost:3000",
    VERCEL_PROJECT_PRODUCTION_URL: "yugantar-finance.vercel.app",
    NODE_ENV: "production",
  });
  expect(appUrl()).toBe("https://yugantar-finance.vercel.app");
});

test("every loopback spelling is caught, not just the word localhost", () => {
  for (const loopback of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
    environment({
      APP_URL: loopback,
      VERCEL_PROJECT_PRODUCTION_URL: "yugantar-finance.vercel.app",
      NODE_ENV: "production",
    });
    expect(appUrl(), loopback).toBe("https://yugantar-finance.vercel.app");
  }
});

test("localhost in development is respected — that is where it is correct", () => {
  environment({ APP_URL: "http://localhost:3000", NODE_ENV: "development" });
  expect(appUrl()).toBe("http://localhost:3000");
});

test("with no APP_URL at all, the platform's URL is used", () => {
  environment({ VERCEL_PROJECT_PRODUCTION_URL: "yugantar-finance.vercel.app", NODE_ENV: "production" });
  expect(appUrl()).toBe("https://yugantar-finance.vercel.app");
});

test("the deployment URL is the last resort before localhost", () => {
  environment({ VERCEL_URL: "yugantar-finance-abc123.vercel.app", NODE_ENV: "production" });
  expect(appUrl()).toBe("https://yugantar-finance-abc123.vercel.app");
});

test("the stable production domain is preferred over this deployment's URL", () => {
  environment({
    VERCEL_PROJECT_PRODUCTION_URL: "yugantar.ajij.dev",
    VERCEL_URL: "yugantar-finance-abc123.vercel.app",
    NODE_ENV: "production",
  });
  // A preview deployment's URL in a sign-in email would work once and rot.
  expect(appUrl()).toBe("https://yugantar.ajij.dev");
});

test("with nothing set at all it falls back to localhost rather than throwing", () => {
  environment({});
  expect(appUrl()).toBe("http://localhost:3000");
});

test("a blank APP_URL is treated as unset, not as an empty origin", () => {
  environment({ APP_URL: "   ", VERCEL_PROJECT_PRODUCTION_URL: "yugantar.ajij.dev", NODE_ENV: "production" });
  expect(appUrl()).toBe("https://yugantar.ajij.dev");
});
