/**
 * Object storage behind the PRD 20.2 presign → PUT → complete flow.
 *
 * R2 is the production backend (private bucket, presigned PUT, 15-minute signed GET).
 * Until credentials exist we write to `.uploads/` and sign with an HMAC of the same
 * shape, so the upload flow, hashing and attachment binding are identical either way.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** PRD 14 — file types and sizes. */
export const ALLOWED_MIME = [
  "image/jpeg", "image/png", "image/heic", "image/heif", "image/webp", "application/pdf",
] as const;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const SIGNED_URL_TTL_SECONDS = 15 * 60;

export const r2Configured = () =>
  Boolean(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET);

const LOCAL_ROOT = resolve(process.cwd(), ".uploads");
const signingSecret = () => process.env.CRON_SECRET || "dev-upload-secret";

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
  return `${festId}/${attachmentId}${ext}`;
}

function sign(key: string, expiresAt: number): string {
  return createHmac("sha256", signingSecret()).update(`${key}:${expiresAt}`).digest("hex");
}

export function verifySignature(key: string, expiresAt: number, signature: string): boolean {
  if (Date.now() > expiresAt) return false;
  const expected = Buffer.from(sign(key, expiresAt));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export interface PresignedUpload {
  uploadUrl: string;
  storageKey: string;
}

export async function presignUpload(key: string): Promise<PresignedUpload> {
  if (r2Configured()) {
    throw new Error("R2 backend not wired yet — set the R2_* variables and implement presignUpload");
  }
  const expiresAt = Date.now() + SIGNED_URL_TTL_SECONDS * 1000;
  const qs = new URLSearchParams({ key, expires: String(expiresAt), sig: sign(key, expiresAt) });
  return { uploadUrl: `/api/v1/attachments/upload?${qs}`, storageKey: key };
}

/** Signed GET (20.2). Attachments are never served from a public URL (PRD 11). */
export async function signedDownloadUrl(key: string): Promise<string> {
  if (r2Configured()) {
    throw new Error("R2 backend not wired yet — set the R2_* variables and implement signedDownloadUrl");
  }
  const expiresAt = Date.now() + SIGNED_URL_TTL_SECONDS * 1000;
  const qs = new URLSearchParams({ key, expires: String(expiresAt), sig: sign(key, expiresAt) });
  return `/api/v1/attachments/download?${qs}`;
}

export async function putObject(key: string, body: Buffer): Promise<void> {
  const path = join(LOCAL_ROOT, key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
}

export async function getObject(key: string): Promise<Buffer> {
  return readFile(join(LOCAL_ROOT, key));
}

export async function objectExists(key: string): Promise<{ sizeBytes: number } | null> {
  try {
    const s = await stat(join(LOCAL_ROOT, key));
    return { sizeBytes: s.size };
  } catch {
    return null;
  }
}

/** F1 leans on both: sha256 catches an identical file, phash a re-photographed one. */
export function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}
