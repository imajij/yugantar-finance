/**
 * `pnpm env:check` — what is configured, what that unlocks, and what is missing.
 *
 * Every external service in this app is optional and degrades to something usable
 * (see the README), which is convenient right up until you cannot tell whether a
 * feature is off because you meant it to be or because a key never landed. This
 * prints that, plus the two things that actually cause lost afternoons: values that
 * are present but blank, and a key set in one env file and overridden by another.
 *
 * Reads the files the way Next.js does — `.env`, then `.env.local` on top, then the
 * real environment on top of that — so what it reports is what the app will see.
 * Never prints a secret: only whether it is there, and where it came from.
 */
import { readFileSync } from "node:fs";

/* ------------------------------------------------------------ loading, as Next does */

type Source = ".env" | ".env.local" | "environment";

interface Value {
  value: string;
  from: Source;
  /** Files this was also set in, but overridden — the quiet source of confusion. */
  shadowed: Source[];
}

const FILES: Source[] = [".env", ".env.local"];
const resolved = new Map<string, Value>();

function parse(file: string): Map<string, string> {
  const out = new Map<string, string>();
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    // Strip matching quotes the way dotenv does, then trim.
    const raw = match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    out.set(match[1], raw.trim());
  }
  return out;
}

const present: Source[] = FILES.filter((f) => {
  try { readFileSync(f); return true; } catch { return false; }
});

for (const file of FILES) {
  for (const [key, value] of parse(file)) {
    const existing = resolved.get(key);
    resolved.set(key, {
      value,
      from: file,
      shadowed: existing ? [...existing.shadowed, existing.from] : [],
    });
  }
}

// The real environment wins over both, which is how a deployment overrides a file.
for (const [key, value] of Object.entries(process.env)) {
  if (value === undefined || !resolved.has(key)) continue;
  const existing = resolved.get(key)!;
  if (value !== existing.value) {
    resolved.set(key, { value, from: "environment", shadowed: [...existing.shadowed, existing.from] });
  }
}

/** Blank is unset — the rule from `lib/env.ts`. */
const get = (key: string): Value | null => {
  const found = resolved.get(key) ?? (process.env[key] !== undefined
    ? { value: process.env[key]!, from: "environment" as Source, shadowed: [] }
    : null);
  if (!found) return null;
  return found.value.trim() === "" ? null : found;
};

/* ------------------------------------------------------------------- the roster */

interface Group {
  title: string;
  /** What works when every `keys` entry is set. */
  unlocks: string;
  /** What happens when they are not. */
  without: string;
  keys: string[];
  /** Required for the app to run at all. */
  required?: boolean;
  where?: string;
}

const GROUPS: Group[] = [
  {
    title: "Database",
    keys: ["DATABASE_URL"],
    unlocks: "everything",
    without: "the app cannot start",
    required: true,
    where: "Neon connection string, or the local Docker container",
  },
  {
    title: "App",
    keys: ["APP_URL", "ALLOWED_EMAIL_DOMAIN"],
    unlocks: "correct links in email, and the college-domain restriction",
    without: "links point at localhost and any domain may be invited",
    required: true,
  },
  {
    title: "Email — Resend",
    keys: ["RESEND_API_KEY", "EMAIL_FROM"],
    unlocks: "sign-in links, invitations and every notification actually being sent",
    without: "mail is written to the server log instead; only you can get in",
    where: "resend.com → API Keys. EMAIL_FROM must be on a verified domain",
  },
  {
    title: "Files — Cloudflare R2",
    keys: ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"],
    unlocks: "receipts and invoices stored in the bucket",
    without: "files go to ./.uploads on the server's disk — fine locally, lost on redeploy",
    where: "Cloudflare → R2 → API → Manage API tokens → Object Read & Write",
  },
  {
    title: "Auth — Clerk (optional)",
    keys: ["CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"],
    unlocks: "Google sign-in restricted to the college domain (PRD 13)",
    without: "sign-in is an emailed one-time link, which needs Resend to reach anyone",
    where: "clerk.com → API Keys",
  },
  {
    title: "Jobs",
    keys: ["CRON_SECRET"],
    unlocks: "the scheduled jobs in vercel.json",
    without: "every /api/v1/cron/* endpoint returns 403 and nothing runs on a clock",
    required: true,
    where: "any secret: openssl rand -hex 32",
  },
  {
    title: "AI (v1.1, not built)",
    keys: ["ANTHROPIC_API_KEY"],
    unlocks: "nothing yet — receipt OCR and flags F7/F10/F11 are after launch",
    without: "no effect",
  },
];

/* --------------------------------------------------------------------- report */

const GREEN = "\x1b[32m", YELLOW = "\x1b[33m", RED = "\x1b[31m", DIM = "\x1b[2m", OFF = "\x1b[0m";
const isProd = process.env.NODE_ENV === "production";

console.log(`\nConfiguration${present.length ? `  ${DIM}(read from ${present.join(", ")})${OFF}` : ""}\n`);

const warnings: string[] = [];
const blockers: string[] = [];
const duplicated: string[] = [];

for (const group of GROUPS) {
  const states = group.keys.map((k) => ({ key: k, value: get(k) }));
  const missing = states.filter((s) => !s.value);
  const complete = missing.length === 0;

  const mark = complete ? `${GREEN}●${OFF}` : group.required ? `${RED}●${OFF}` : `${YELLOW}○${OFF}`;
  console.log(`${mark} ${group.title}`);

  for (const { key, value } of states) {
    if (value) {
      const note = value.shadowed.length
        ? `${DIM}from ${value.from}, also set in ${value.shadowed.join(", ")}${OFF}`
        : `${DIM}from ${value.from}${OFF}`;
      console.log(`    ${GREEN}✓${OFF} ${key.padEnd(34)} ${note}`);
      if (value.shadowed.length) duplicated.push(key);
    } else {
      const blank = resolved.has(key);
      console.log(`    ${group.required ? RED : YELLOW}·${OFF} ${key.padEnd(34)} ${DIM}${blank ? "present but blank" : "not set"}${OFF}`);
    }
  }

  if (complete) {
    console.log(`    ${DIM}→ ${group.unlocks}${OFF}`);
  } else {
    console.log(`    ${DIM}→ ${group.without}${OFF}`);
    if (group.where) console.log(`    ${DIM}  get it: ${group.where}${OFF}`);
    if (group.required) blockers.push(`${group.title}: ${group.without}`);
  }
  console.log();
}

/* ----------------------------------------------------- things that bite in production */

const productionNotes: string[] = [];

const appUrl = get("APP_URL")?.value ?? "";
if (appUrl.includes("localhost")) {
  productionNotes.push("APP_URL still points at localhost — emailed links will be unusable.");
}
if (get("CRON_SECRET")?.value === "dev-cron-secret") {
  productionNotes.push("CRON_SECRET is still the example value; anyone could trigger the cron jobs.");
}
if (!get("R2_ACCESS_KEY_ID") && !get("UPLOAD_URL_SECRET")) {
  productionNotes.push(
    "Without R2, uploads use local disk and UPLOAD_URL_SECRET is required in production "
    + "(lib/storage.ts refuses to sign otherwise).",
  );
}
if (!get("RESEND_API_KEY")) {
  productionNotes.push("Without RESEND_API_KEY nobody you invite can sign in — their link is only logged.");
}

const dbUrl = get("DATABASE_URL")?.value ?? "";
if (/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(dbUrl)) {
  productionNotes.push(
    "DATABASE_URL points at localhost. A serverless function has no local Postgres, "
    + "so every request that touches the database will fail — use the Neon URL.",
  );
}

// Half-configured Clerk used to 500 every page, including sign-in. It degrades now,
// but it is still never what anyone meant.
const clerkSet = ["CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"].filter((k) => get(k));
if (clerkSet.length === 1) {
  warnings.push(
    `Only ${clerkSet[0]} is set. Clerk needs both keys, so it is disabled and sign-in `
    + "falls back to emailed links. Set both, or clear the one that is set.",
  );
}

if (duplicated.length) {
  warnings.push(
    `Both ${present.join(" and ")} exist, and ${duplicated.length} key`
    + `${duplicated.length === 1 ? " is" : "s are"} set in both: ${duplicated.join(", ")}. `
    + "Next reads .env then .env.local on top, so the second silently wins. Keeping one "
    + "file — .env.local, which is the one the README documents — avoids the confusion.",
  );
} else if (present.length > 1) {
  warnings.push(`Both ${present.join(" and ")} exist. .env.local wins where they overlap.`);
}

if (warnings.length) {
  console.log(`${YELLOW}Worth knowing${OFF}`);
  for (const w of warnings) console.log(`  · ${w}`);
  console.log();
}

if (productionNotes.length) {
  console.log(`${YELLOW}Before this goes live${OFF}`);
  for (const n of productionNotes) console.log(`  · ${n}`);
  console.log();
}

if (blockers.length) {
  console.log(`${RED}Missing something the app needs to run${OFF}`);
  for (const b of blockers) console.log(`  · ${b}`);
  console.log();
  process.exit(1);
}

console.log(`${DIM}Set a key by editing the env file, then restart the dev server. On Vercel these
live in Project → Settings → Environment Variables instead, and a redeploy is what
picks them up. Check R2 specifically with: pnpm r2:check${OFF}\n`);

if (isProd) process.exit(productionNotes.length ? 1 : 0);
