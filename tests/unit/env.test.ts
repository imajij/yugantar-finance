/**
 * Configuration reading, and the R2 presigning that hangs off it.
 *
 * These exist because of one real bug: `.env.example` lists every optional variable
 * with nothing after the `=`, and copying it — the documented first step — leaves
 * `R2_ENDPOINT=""` rather than absent. `??` falls back on `undefined`, not on `""`,
 * so the empty string won and every presigned URL was built against an empty host.
 *
 * It failed silently and looked like bad credentials. The rule is now "blank is
 * unset" (`lib/env.ts`), and this is what holds it there.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { env, envAllSet, envOr } from "@/lib/env";

const KEYS = [
  "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_ENDPOINT",
  "YG_TEST_VALUE",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("env", () => {
  test("an unset variable is undefined", () => {
    delete process.env.YG_TEST_VALUE;
    expect(env("YG_TEST_VALUE")).toBeUndefined();
  });

  test("an empty variable is undefined, which is the whole point", () => {
    process.env.YG_TEST_VALUE = "";
    expect(env("YG_TEST_VALUE")).toBeUndefined();
  });

  test("a whitespace-only variable is undefined — a trailing space in a .env is not a value", () => {
    process.env.YG_TEST_VALUE = "   ";
    expect(env("YG_TEST_VALUE")).toBeUndefined();
  });

  test("a real value comes back trimmed", () => {
    process.env.YG_TEST_VALUE = "  hello  ";
    expect(env("YG_TEST_VALUE")).toBe("hello");
  });

  test("envOr falls back on blank, not only on absent", () => {
    process.env.YG_TEST_VALUE = "";
    expect(envOr("YG_TEST_VALUE", "fallback")).toBe("fallback");
    delete process.env.YG_TEST_VALUE;
    expect(envOr("YG_TEST_VALUE", "fallback")).toBe("fallback");
    process.env.YG_TEST_VALUE = "set";
    expect(envOr("YG_TEST_VALUE", "fallback")).toBe("set");
  });

  test("envAllSet treats blank as missing", () => {
    process.env.YG_TEST_VALUE = "";
    expect(envAllSet("YG_TEST_VALUE")).toBe(false);
    process.env.YG_TEST_VALUE = "x";
    expect(envAllSet("YG_TEST_VALUE")).toBe(true);
    expect(envAllSet("YG_TEST_VALUE", "YG_DEFINITELY_UNSET")).toBe(false);
  });
});

describe("R2 configuration", () => {
  /** Imported fresh each time: `r2Config` reads `process.env` when called. */
  const storage = () => import("@/lib/storage");

  function configureR2(endpoint: string | undefined) {
    process.env.R2_ACCOUNT_ID = "abc123";
    process.env.R2_ACCESS_KEY_ID = "AKIAEXAMPLE";
    process.env.R2_SECRET_ACCESS_KEY = "s3cret";
    process.env.R2_BUCKET = "yugaantar-receipts";
    if (endpoint === undefined) delete process.env.R2_ENDPOINT;
    else process.env.R2_ENDPOINT = endpoint;
  }

  test("a blank R2_ENDPOINT falls back to the account's own endpoint", async () => {
    configureR2("");
    const { r2Config } = await storage();
    expect(r2Config()?.endpoint).toBe("https://abc123.r2.cloudflarestorage.com");
  });

  test("an absent R2_ENDPOINT does the same", async () => {
    configureR2(undefined);
    const { r2Config } = await storage();
    expect(r2Config()?.endpoint).toBe("https://abc123.r2.cloudflarestorage.com");
  });

  test("a real R2_ENDPOINT is used, with any trailing slash removed", async () => {
    configureR2("https://minio.internal:9000/");
    const { r2Config } = await storage();
    expect(r2Config()?.endpoint).toBe("https://minio.internal:9000");
  });

  test("blank credentials mean not configured, so the local backend stays in charge", async () => {
    configureR2("");
    process.env.R2_SECRET_ACCESS_KEY = "";
    const { r2Config, r2Configured } = await storage();
    expect(r2Config()).toBeNull();
    expect(r2Configured()).toBe(false);
  });

  test("presigned URLs address the bucket and carry a SigV4 signature", async () => {
    configureR2("");
    const { presignUpload, signedDownloadUrl, storageKey } = await storage();

    const key = storageKey("fest-uuid", "attachment-uuid", "receipt.JPG");
    // Keys are opaque, namespaced by fest, and keep only a normalised extension.
    expect(key).toBe("fest-uuid/attachment-uuid.jpg");

    const { uploadUrl } = await presignUpload(key);
    const put = new URL(uploadUrl);
    expect(put.origin).toBe("https://abc123.r2.cloudflarestorage.com");
    expect(put.pathname).toBe("/yugaantar-receipts/fest-uuid/attachment-uuid.jpg");
    expect(put.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(put.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    // PRD 20.2 — fifteen minutes.
    expect(put.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(put.searchParams.get("X-Amz-Credential")).toContain("/auto/s3/aws4_request");

    const get = new URL(await signedDownloadUrl(key));
    expect(get.origin).toBe(put.origin);
    expect(get.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    // A GET and a PUT of the same object must not share a signature.
    expect(get.searchParams.get("X-Amz-Signature"))
      .not.toBe(put.searchParams.get("X-Amz-Signature"));
  });

  test("the signature covers the key, so it cannot be pointed at another object", async () => {
    configureR2("");
    const { presignUpload } = await storage();

    const a = new URL((await presignUpload("fest/one.jpg")).uploadUrl);
    const b = new URL((await presignUpload("fest/two.jpg")).uploadUrl);
    expect(a.searchParams.get("X-Amz-Signature")).not.toBe(b.searchParams.get("X-Amz-Signature"));
  });
});
