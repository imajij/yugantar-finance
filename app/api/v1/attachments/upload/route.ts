import { NextResponse } from "next/server";
import { MAX_FILE_BYTES, putObject, verifySignature } from "@/lib/storage";

/**
 * The local stand-in for R2's presigned PUT (20.2 step 2). Authorization is the
 * signature on the URL, exactly as it would be with R2 — no session required.
 */
export async function PUT(request: Request) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  const expires = Number(url.searchParams.get("expires"));
  const sig = url.searchParams.get("sig");

  if (!key || !sig || !expires || !verifySignature(key, expires, sig)) {
    return NextResponse.json({ error: { code: "FORBIDDEN", message: "Invalid or expired upload URL" } }, { status: 403 });
  }

  const body = Buffer.from(await request.arrayBuffer());
  if (body.byteLength === 0 || body.byteLength > MAX_FILE_BYTES) {
    return NextResponse.json({ error: { code: "VALIDATION_ERROR", message: "File too large or empty" } }, { status: 422 });
  }

  await putObject(key, body);
  return new NextResponse(null, { status: 200 });
}
