/**
 * Object storage behind the PRD 20.2 presign → PUT → complete flow.
 *
 * Two backends, one interface:
 *   - **R2** (production). A private, S3-compatible bucket. Uploads go straight from
 *     the browser to a presigned PUT; reads are presigned GETs that expire in 15
 *     minutes. Signing is SigV4, done here rather than through the AWS SDK — it is
 *     sixty lines and saves a large dependency from the serverless bundle.
 *   - **Local disk** (development and tests). Same shapes, same expiry, same HMAC
 *     discipline, writing under `.uploads/`. The upload flow, hashing and attachment
 *     binding are identical either way, so nothing about the app changes when R2
 *     credentials appear.
 *
 * Neither backend ever produces a public URL (PRD 11). A URL is handed out only by
 * `GET /attachments/{id}/url`, which checks that the caller can see the parent record.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { env, envOr } from "@/lib/env";

/** PRD 14 — file types and sizes. */
export const ALLOWED_MIME = [
  "image/jpeg", "image/png", "image/heic", "image/heif", "image/webp", "application/pdf",
] as const;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const SIGNED_URL_TTL_SECONDS = 15 * 60;

interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  endpoint: string;
}

export function r2Config(): R2Config | null {
  const accountId = env("R2_ACCOUNT_ID");
  const accessKeyId = env("R2_ACCESS_KEY_ID");
  const secretAccessKey = env("R2_SECRET_ACCESS_KEY");
  const bucket = env("R2_BUCKET");
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return {
    accountId, accessKeyId, secretAccessKey, bucket,
    // R2's S3 endpoint. Overridable so the same code runs against MinIO or Supabase.
    // `env` and not `process.env`: `.env.example` ships `R2_ENDPOINT=` blank, and an
    // empty string would sail past `??` and leave every presigned URL hostless.
    endpoint: envOr("R2_ENDPOINT", `https://${accountId}.r2.cloudflarestorage.com`).replace(/\/$/, ""),
  };
}

export const r2Configured = () => r2Config() !== null;

const LOCAL_ROOT = resolve(process.cwd(), ".uploads");

export function validateUpload(mimeType: string, sizeBytes: number): void {
  if (!(ALLOWED_MIME as readonly string[]).includes(mimeType)) {
    throw new Error(`Unsupported file type ${mimeType}. Allowed: JPG, PNG, HEIC, WebP, PDF`);
  }
  if (sizeBytes <= 0 || sizeBytes > MAX_FILE_BYTES) {
    throw new Error(`Files must be between 1 byte and ${MAX_FILE_BYTES / 1024 / 1024} MB`);
  }
}

/** Keys are opaque and namespaced by fest so a bucket listing reveals nothing useful. */
export function storageKey(festId: string, attachmentId: string, fileName: string): string {
  const ext = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")).toLowerCase() : "";
  return `${festId}/${attachmentId}${ext.replace(/[^a-z0-9.]/g, "")}`;
}

/* ------------------------------------------------------------ AWS SigV4 */

const SERVICE = "s3";
const REGION = "auto"; // R2 has one region and calls it `auto`.
const UNSIGNED = "UNSIGNED-PAYLOAD";

const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data, "utf8").digest();
const hex = (b: Buffer) => b.toString("hex");
const sha256hex = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

/** S3 wants each path segment encoded, but not the slashes between them. */
function encodeKey(key: string): string {
  return key.split("/").map((s) => encodeURIComponent(s)).join("/");
}

function signingKey(secret: string, date: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), REGION), SERVICE), "aws4_request");
}

function stamps(now = new Date()): { amzDate: string; date: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, date: amzDate.slice(0, 8) };
}

/**
 * A presigned URL carrying the signature in the query string (SigV4 "query auth").
 * The browser then does a plain PUT or GET with no credentials of its own.
 */
function presign(cfg: R2Config, method: "PUT" | "GET", key: string, expiresIn: number): string {
  const { amzDate, date } = stamps();
  const host = new URL(cfg.endpoint).host;
  const canonicalUri = `/${cfg.bucket}/${encodeKey(key)}`;
  const credential = `${cfg.accessKeyId}/${date}/${REGION}/${SERVICE}/aws4_request`;

  const query = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": credential,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresIn),
    "X-Amz-SignedHeaders": "host",
  });
  // URLSearchParams sorts nothing; SigV4 requires the canonical query sorted by key.
  const canonicalQuery = [...query.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const canonicalRequest = [
    method, canonicalUri, canonicalQuery, `host:${host}\n`, "host", UNSIGNED,
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256", amzDate, `${date}/${REGION}/${SERVICE}/aws4_request`,
    sha256hex(canonicalRequest),
  ].join("\n");

  const signature = hex(hmac(signingKey(cfg.secretAccessKey, date), stringToSign));
  return `${cfg.endpoint}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** Server-to-server call, signed with an `Authorization` header rather than a query. */
async function r2Fetch(
  cfg: R2Config, method: "PUT" | "GET" | "HEAD" | "DELETE", key: string, body?: Buffer,
): Promise<Response> {
  const { amzDate, date } = stamps();
  const host = new URL(cfg.endpoint).host;
  const canonicalUri = `/${cfg.bucket}/${encodeKey(key)}`;
  const payloadHash = sha256hex(body ?? Buffer.alloc(0));

  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort().map((h) => `${h}:${headers[h]}\n`).join("");

  const canonicalRequest = [
    method, canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash,
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256", amzDate, `${date}/${REGION}/${SERVICE}/aws4_request`,
    sha256hex(canonicalRequest),
  ].join("\n");

  const signature = hex(hmac(signingKey(cfg.secretAccessKey, date), stringToSign));
  const credential = `${cfg.accessKeyId}/${date}/${REGION}/${SERVICE}/aws4_request`;

  return fetch(`${cfg.endpoint}${canonicalUri}`, {
    method,
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${credential}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body: body ? new Uint8Array(body) : undefined,
  });
}

/* ------------------------------------------------- local-disk signatures */

/**
 * The local backend needs its own URL signature. It is deliberately not the
 * `CRON_SECRET`: two unrelated trust boundaries must not share a key.
 */
function signingSecret(): string {
  const secret = env("UPLOAD_URL_SECRET");
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error("UPLOAD_URL_SECRET must be set when running without R2");
  }
  return "dev-upload-secret";
}

function sign(key: string, expiresAt: number): string {
  return createHmac("sha256", signingSecret()).update(`${key}:${expiresAt}`).digest("hex");
}

export function verifySignature(key: string, expiresAt: number, signature: string): boolean {
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;
  const expected = Buffer.from(sign(key, expiresAt));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

function localSignedUrl(path: string, key: string): string {
  const expiresAt = Date.now() + SIGNED_URL_TTL_SECONDS * 1000;
  const qs = new URLSearchParams({ key, expires: String(expiresAt), sig: sign(key, expiresAt) });
  return `${path}?${qs}`;
}

/* --------------------------------------------------------- the interface */

export interface PresignedUpload {
  uploadUrl: string;
  storageKey: string;
}

export async function presignUpload(key: string): Promise<PresignedUpload> {
  const cfg = r2Config();
  if (cfg) return { uploadUrl: presign(cfg, "PUT", key, SIGNED_URL_TTL_SECONDS), storageKey: key };
  return { uploadUrl: localSignedUrl("/api/v1/attachments/upload", key), storageKey: key };
}

/** Signed GET (20.2). Callers must have checked visibility of the parent record first. */
export async function signedDownloadUrl(key: string): Promise<string> {
  const cfg = r2Config();
  if (cfg) return presign(cfg, "GET", key, SIGNED_URL_TTL_SECONDS);
  return localSignedUrl("/api/v1/attachments/download", key);
}

export async function putObject(key: string, body: Buffer): Promise<void> {
  const cfg = r2Config();
  if (cfg) {
    const res = await r2Fetch(cfg, "PUT", key, body);
    if (!res.ok) throw new Error(`R2 PUT ${key} failed: ${res.status} ${await res.text()}`);
    return;
  }
  const path = join(LOCAL_ROOT, key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
}

export async function getObject(key: string): Promise<Buffer> {
  const cfg = r2Config();
  if (cfg) {
    const res = await r2Fetch(cfg, "GET", key);
    if (!res.ok) throw new Error(`R2 GET ${key} failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  return readFile(join(LOCAL_ROOT, key));
}

export async function objectExists(key: string): Promise<{ sizeBytes: number } | null> {
  const cfg = r2Config();
  if (cfg) {
    const res = await r2Fetch(cfg, "HEAD", key);
    if (!res.ok) return null;
    return { sizeBytes: Number(res.headers.get("content-length") ?? 0) };
  }
  try {
    const s = await stat(join(LOCAL_ROOT, key));
    return { sizeBytes: s.size };
  } catch {
    return null;
  }
}

/** Used only by the attachment GC (20.2 step 4) — nothing a user can see is deleted. */
export async function deleteObject(key: string): Promise<void> {
  const cfg = r2Config();
  if (cfg) {
    await r2Fetch(cfg, "DELETE", key);
    return;
  }
  const { unlink } = await import("node:fs/promises");
  await unlink(join(LOCAL_ROOT, key)).catch(() => {});
}

/** F1 leans on both: sha256 catches an identical file, phash a re-photographed one. */
export function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}
