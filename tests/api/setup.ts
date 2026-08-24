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

installSessionMock();
