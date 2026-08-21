import { NextResponse } from "next/server";
import { getObject, verifySignature } from "@/lib/storage";

/** Signed, expiring GET (PRD 11) — files are never served from a public URL. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  const expires = Number(url.searchParams.get("expires"));
  const sig = url.searchParams.get("sig");

  if (!key || !sig || !expires || !verifySignature(key, expires, sig)) {
    return NextResponse.json({ error: { code: "FORBIDDEN", message: "Invalid or expired link" } }, { status: 403 });
  }

  try {
    const body = await getObject(key);
    return new NextResponse(new Uint8Array(body), {
      headers: { "content-type": "application/octet-stream", "cache-control": "private, max-age=900" },
    });
  } catch {
    return NextResponse.json({ error: { code: "NOT_FOUND", message: "File not found" } }, { status: 404 });
  }
}
