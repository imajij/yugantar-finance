/**
 * Loaded by Vitest before every API test file (see `vitest.config.mts`).
 *
 * Two things have to be in place before any route handler is imported:
 *   - the session seam, since `requireSession()` reads cookies that do not exist
 *     outside a request;
 *   - `after()`, which Next only provides inside a request context. The route
 *     wrapper uses it to flush the email outbox; here it runs the callback inline
 *     so the outbox behaviour is still exercised rather than skipped.
 */
import { vi } from "vitest";
import { installSessionMock } from "./harness";

vi.mock("next/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("next/server")>();
  return { ...original, after: (fn: () => unknown) => { void fn(); } };
});

/**
 * A cookie jar. `cookies()` throws outside a request scope, which a handler that
 * reads or clears one — signing out, for instance — hits immediately. The jar starts
 * empty, which is exactly the anonymous case these tests care about; `harness.ts`
 * carries the session separately, so nothing here needs to fake one.
 */
vi.mock("next/headers", async (importOriginal) => {
  const original = await importOriginal<typeof import("next/headers")>();
  const jar = new Map<string, string>();
  return {
    ...original,
    cookies: async () => ({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      has: (name: string) => jar.has(name),
      set: (name: string, value: string) => { jar.set(name, value); },
      delete: (name: string) => { jar.delete(name); },
    }),
  };
});

installSessionMock();
