/**
 * `pnpm r2:check` — proves the R2 configuration end to end, against the real bucket.
 *
 * It exercises the same code paths the app does (`lib/storage.ts`), in the same order
 * a receipt takes (PRD 20.2): presign a PUT, upload through it as a browser would,
 * read the object back server-side the way `complete` does to hash it, fetch it
 * through a presigned GET, then clean up after itself.
 *
 * Worth having because the SigV4 signing here is hand-rolled rather than an SDK, and
 * a signature that is subtly wrong fails only against the real service. Unit tests
 * can check the shape of a URL; only this can check that Cloudflare accepts it.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";

const step = (n: number, what: string) => process.stdout.write(`  ${n}. ${what.padEnd(46)}`);
const ok = (detail = "") => console.log(`ok${detail ? `  ${detail}` : ""}`);

function fail(message: string, hint?: string): never {
  console.log("FAILED");
  console.error(`\n  ${message}`);
  if (hint) console.error(`\n  ${hint}`);
  process.exit(1);
}

const { r2Config, presignUpload, signedDownloadUrl, getObject, objectExists, deleteObject, sha256 } =
  await import("../lib/storage.js");

console.log("\nR2 configuration check\n");

/* ------------------------------------------------------------ configuration */

step(1, "credentials present");
const cfg = r2Config();
if (!cfg) {
  fail(
    "R2 is not configured, so the app is using local disk storage instead.",
    "All four of R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET\n"
    + "  must be set to something. Blank counts as unset (lib/env.ts).",
  );
}
ok(`${cfg.bucket} @ ${cfg.endpoint}`);

/* ------------------------------------------------------------------ presign */

const key = `_r2-check/${randomBytes(8).toString("hex")}.bin`;
const body = randomBytes(4096);

step(2, "presign a PUT");
const { uploadUrl } = await presignUpload(key);
const parsed = new URL(uploadUrl);
if (!parsed.searchParams.get("X-Amz-Signature")) fail("The presigned URL carries no signature.");
ok(`expires in ${parsed.searchParams.get("X-Amz-Expires")}s`);

/* ------------------------------------------------- upload, as a browser would */

step(3, "upload through it");
const put = await fetch(uploadUrl, {
  method: "PUT",
  body: new Uint8Array(body),
  headers: { "content-type": "application/octet-stream" },
});
if (!put.ok) {
  const detail = await put.text().catch(() => "");
  fail(
    `R2 refused the upload: ${put.status} ${put.statusText}`,
    put.status === 401 || put.status === 403
      ? "That is a credentials problem. Check the Access Key ID and Secret Access Key,\n"
        + "  and that the API token is scoped to this bucket with Object Read & Write."
      : detail.slice(0, 400),
  );
}
ok(`${body.length} bytes`);

/* ---------------------------------------------------------- server-side read */

step(4, "server-side HEAD (what `complete` does)");
const meta = await objectExists(key);
if (!meta) fail("The object is not there after a successful upload.");
if (meta.sizeBytes !== body.length) {
  fail(`R2 reports ${meta.sizeBytes} bytes, but ${body.length} were uploaded.`);
}
ok(`${meta.sizeBytes} bytes`);

step(5, "server-side GET, and the hash matches");
const fetched = await getObject(key);
if (sha256(fetched) !== sha256(body)) {
  fail("The bytes read back are not the bytes written — F1's duplicate detection would be wrong.");
}
ok(`sha256 ${sha256(body).slice(0, 12)}…`);

/* ------------------------------------------------------------- presigned GET */

step(6, "presign a GET and follow it");
const downloadUrl = await signedDownloadUrl(key);
const got = await fetch(downloadUrl);
if (!got.ok) fail(`The signed download URL was refused: ${got.status} ${got.statusText}`);
if (Buffer.from(await got.arrayBuffer()).length !== body.length) {
  fail("The signed download returned the wrong number of bytes.");
}
ok("15-minute signed read");

/* -------------------------------------------------------------- private-ness */

step(7, "the object is not public");
const bare = `${cfg.endpoint}/${cfg.bucket}/${key}`;
const anonymous = await fetch(bare).catch(() => null);
if (anonymous?.ok) {
  fail(
    "The object is readable without a signature. The bucket is public.",
    "Turn off public access: npx wrangler r2 bucket dev-url disable " + cfg.bucket,
  );
}
ok(`unsigned request refused (${anonymous?.status ?? "no response"})`);

/* -------------------------------------------------------------------- tidy up */

step(8, "clean up the probe object");
await deleteObject(key);
ok(await objectExists(key) ? "still present — check lifecycle rules" : "gone");

console.log(`
Everything the app needs is working. What this did not check:

  CORS, which only a browser can exercise. Upload a receipt from the app and watch
  the network tab: a preflighted OPTIONS then a PUT, both to the bucket. If the PUT
  is blocked, add the origin to infra/r2-cors.json and reapply it.
`);

process.exit(0);
