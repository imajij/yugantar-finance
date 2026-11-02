/**
 * Every endpoint, refused to a stranger.
 *
 * The permission matrix in `permissions.test.ts` is a hand-written list, which means
 * it protects exactly the endpoints somebody remembered to add to it. This one walks
 * `app/api/v1` instead and tests whatever it finds, so an endpoint added tomorrow
 * without a guard fails this without anybody thinking to extend it.
 *
 * That is the property worth having. The failure mode being guarded against is not a
 * clever attack; it is a route file written in a hurry that forgot `route()`.
 *
 * Anonymous is the only case here. Who may do what once signed in is the matrix's
 * job, and cross-fest reachability is `fest-isolation.test.ts`.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { call, type Handler } from "./harness";

const ROOT = "app/api/v1";
const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;

interface Endpoint {
  /** `/v1/line-items/[id]/documents` */
  path: string;
  /** Import specifier for the route module. */
  specifier: string;
  /** Route params, filled with plausible-looking values. */
  params: Record<string, string>;
}

/** Every `route.ts` under `app/api/v1`, with its dynamic segments filled in. */
function discover(dir = ROOT): Endpoint[] {
  const found: Endpoint[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...discover(full));
    } else if (entry === "route.ts") {
      const relative = dir.slice(ROOT.length);
      const params: Record<string, string> = {};
      for (const [, name] of relative.matchAll(/\[\.{0,3}(\w+)\]/g)) {
        // A well-formed id the caller could have guessed. It must not matter.
        params[name] = crypto.randomUUID();
      }
      found.push({ path: relative || "/", specifier: `@/${dir}/route`, params });
    }
  }
  return found;
}

const ENDPOINTS = discover();

/** Bodies that get far enough to be interesting, per endpoint shape. */
function bodyFor(path: string): unknown {
  if (path.includes("/auth/request-link")) return { email: "stranger@sst.scaler.com" };
  if (path.includes("/transitions")) return { action: "APPROVE", reason: "no" };
  if (path.includes("/comments")) return { entity_type: "REIMBURSEMENT", entity_id: crypto.randomUUID(), body: "hello" };
  if (path.includes("/flags/evaluate")) return { entity_type: "LINE_ITEM", entity_id: crypto.randomUUID() };
  if (path.includes("/bulk-approve")) return { ids: [crypto.randomUUID()] };
  return {};
}

/**
 * What counts as "not served". A redirect is included because a page answers an
 * unauthenticated request by sending it to sign-in, and 404 because some handlers
 * refuse by pretending the record is not there — both are refusals, and neither leaks.
 */
const REFUSED_STATUS = new Set([301, 302, 307, 308, 400, 401, 403, 404, 422, 429]);

/**
 * Endpoints that are public on purpose, and why each one is safe.
 *
 * Every entry here is a decision, not an exemption: these are reachable without a
 * session because they *must* be, and each carries its own proof of authority.
 */
const PUBLIC_BY_DESIGN: Record<string, string> = {
  "/auth/request-link": "no session exists yet; issuing is invitation-gated and rate limited, and the response never varies",
  "/auth/sign-out": "clearing a session you may not have is harmless",
  "/attachments/upload": "the presigned URL's signature is the authority",
  "/attachments/download": "the presigned URL's signature is the authority",
  "/bills/[id]": "the signature in the exported link is the authority; without it, a 404",
};

const isPublic = (path: string) => Object.keys(PUBLIC_BY_DESIGN).some((p) => path === p);
const isCron = (path: string) => path.startsWith("/cron");

test("the sweep actually found the API", () => {
  // A broken walk would silently pass every case below.
  expect(ENDPOINTS.length).toBeGreaterThan(60);
  expect(ENDPOINTS.map((e) => e.path)).toContain("/reimbursements/[id]/transitions");
});

describe.each(ENDPOINTS)("$path", ({ path, specifier, params }) => {
  test("refuses an anonymous caller on every method it exports", async () => {
    const handlers = (await import(specifier)) as Record<string, Handler | undefined>;
    const exported = METHODS.filter((m) => typeof handlers[m] === "function");
    expect(exported.length, `${path} exports no HTTP methods`).toBeGreaterThan(0);

    for (const method of exported) {
      const result = await call(handlers[method]!, {
        method,
        params,
        ...(method === "GET" ? {} : { body: bodyFor(path) }),
      });

      if (isPublic(path)) {
        // Reachable on purpose. It must still not have acted as somebody.
        expect(result.text, `${method} ${path} leaked a session`).not.toMatch(/festId|"role"/);
        continue;
      }

      if (isCron(path)) {
        expect(result.status, `${method} ${path} ran without CRON_SECRET`).toBe(403);
        continue;
      }

      expect(
        REFUSED_STATUS.has(result.status),
        `${method} ${path} answered ${result.status} to a stranger — it should refuse`,
      ).toBe(true);

      // 200 with a body is the failure this file exists to catch.
      expect(result.status, `${method} ${path} served a stranger`).not.toBe(200);
    }
  });
});

test("every public endpoint is public deliberately, with a stated reason", () => {
  // Keeps the allowlist honest: an entry that no longer matches a real route, or a
  // route quietly added under /auth, shows up here rather than passing unnoticed.
  const paths = new Set(ENDPOINTS.map((e) => e.path));
  for (const allowed of Object.keys(PUBLIC_BY_DESIGN)) {
    expect(paths.has(allowed), `${allowed} is allowlisted but no longer exists`).toBe(true);
    expect(PUBLIC_BY_DESIGN[allowed].length).toBeGreaterThan(20);
  }
});
