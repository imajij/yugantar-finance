/**
 * Where the interface breaks at a given width.
 *
 * "Not responsive" is a symptom with one dominant cause: something on the page is
 * wider than the viewport, so the whole document scrolls sideways and every column
 * of text goes with it. That is measurable rather than a matter of taste — load the
 * page at a width, compare `scrollWidth` against `clientWidth`, and if it overflows,
 * walk the DOM for the elements whose right edge is past the viewport.
 *
 * The widths are the real ones: a small phone, a large phone, a tablet, and the
 * narrowest laptop anybody runs the sidebar on.
 *
 *   pnpm responsive              every screen, every width
 *   pnpm responsive /budget      one path
 */
import { randomBytes } from "node:crypto";
import { chromium, type Page } from "playwright";
import postgres from "postgres";
import { createHash } from "node:crypto";

const BASE = process.env.APP_URL ?? "http://localhost:3000";
const only = process.argv[2];

const WIDTHS = [
  { name: "phone-sm", width: 360, height: 780 },
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "laptop", width: 1024, height: 720 },
  { name: "desktop", width: 1440, height: 900 },
];

/**
 * Every screen a signed-in person can reach that renders its own layout.
 *
 * The `{id}` paths are filled from the database. This matters more than it sounds:
 * an empty table renders an empty state and fits any width, so a sweep against a
 * fresh seed passes everything and proves nothing. Run `pnpm smoke` first — it
 * leaves behind a fest with enough of everything to make the wide layouts appear.
 */
const PATHS = [
  "/dashboard", "/budget", "/budget/{department}", "/budget/review",
  "/budget/{department}/line-items/{lineItem}",
  "/requests", "/requests/{reimbursement}", "/requests/new",
  "/queues", "/vendors", "/vendors/{vendor}", "/vendors/new",
  "/vendors/requests/{vendorRequest}", "/vendors/requests/new",
  "/income", "/tickets", "/tickets?layout=list", "/tickets/{ticket}",
  "/tickets/new", "/tickets/planning",
  "/chat", "/chat/{channel}",
  "/flags", "/notifications", "/audit", "/close-out", "/admin",
];

interface Offender { tag: string; cls: string; right: number; width: number; text: string }
interface Wide { cls: string; content: number; box: number; text: string }
interface Row {
  path: string; width: string; overflowBy: number; offenders: Offender[];
  /** Scrollers you have to swipe to read — legal, and still bad on a phone. */
  wide: Wide[];
  /** Interactive controls the fixed tab bar sits on top of. */
  buried: number;
  error?: string;
}

/**
 * The elements actually sticking out.
 *
 * Only the outermost one in any chain is reported: a wide table makes every cell
 * inside it overflow too, and listing forty cells hides the one thing to fix.
 */
async function overflowAt(page: Page, viewport: number): Promise<{ by: number; offenders: Offender[] }> {
  return page.evaluate((vw) => {
    void vw;
    // The content box, not the window: a vertical scrollbar narrows `clientWidth`
    // while `scrollWidth` stays at the full width, which reads as a phantom few
    // pixels of overflow on any page long enough to scroll.
    const limit = document.documentElement.clientWidth;

    const found: { el: Element; right: number; width: number; clipped: boolean }[] = [];
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right <= limit + 1) continue;
      // A deliberate horizontal scroller — a board, a table in a scroll box — clips
      // its own content, so what is inside it does not move the page sideways. The
      // scroller's own box still has to fit, and that is checked like anything else.
      const clipped = Boolean(
        el.parentElement?.closest(".overflow-x-auto, .overflow-x-scroll, [data-scroll-x]"),
      );
      found.push({ el, right: r.right, width: r.width, clipped });
    }

    // Only the outermost of each chain: a wide table makes every cell inside it
    // overflow too, and listing forty cells hides the one thing to fix.
    const outer = found.filter((a) => !found.some((b) => b !== a && b.el.contains(a.el)));
    const real = outer.filter((a) => !a.clipped);
    if (real.length === 0) return { by: 0, offenders: [] };

    const by = Math.round(Math.max(...real.map((r) => r.right)) - limit);

    return {
      by,
      offenders: real
        .sort((a, b) => b.right - a.right)
        .slice(0, 6)
        .map(({ el, right, width }) => ({
          tag: el.tagName.toLowerCase(),
          cls: (el.getAttribute("class") ?? "").slice(0, 110),
          right: Math.round(right),
          width: Math.round(width),
          text: (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60),
        })),
    };
  }, viewport);
}

/**
 * The two breakages that are not overflow.
 *
 * **Wide scrollers.** A table in an `overflow-x-auto` box does not move the page
 * sideways, so the check above passes it — and a 680px row inside a 360px phone is
 * still something nobody can read. Reported as a warning rather than a failure,
 * because a Kanban board is *meant* to scroll and a table of people is not.
 *
 * **Buried controls.** The bottom tab bar is fixed. Anything interactive underneath
 * it cannot be tapped, which is the kind of break that looks fine in a screenshot.
 * Measured at the *bottom* of the page: mid-scroll, whatever happens to sit in that
 * band can be scrolled out of it, and only what is still there at the end is stuck.
 */
async function auditAt(page: Page): Promise<{ wide: Wide[]; buried: number }> {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(120);
  return page.evaluate(() => {
    const limit = document.documentElement.clientWidth;

    const wide: Wide[] = [];
    for (const el of Array.from(document.querySelectorAll(".overflow-x-auto, .overflow-x-scroll, [data-scroll-x]"))) {
      const box = el.getBoundingClientRect().width;
      // A board is a deliberate horizontal surface; opt it out by marking it.
      if (el.hasAttribute("data-scroll-x")) continue;
      if (el.scrollWidth <= box + 24) continue;
      wide.push({
        cls: (el.getAttribute("class") ?? "").slice(0, 70),
        content: Math.round(el.scrollWidth),
        box: Math.round(box),
        text: (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 50),
      });
    }

    let buried = 0;
    const bar = document.querySelector("nav.fixed");
    if (bar) {
      const b = bar.getBoundingClientRect();
      if (b.height > 0) {
        for (const el of Array.from(document.querySelectorAll("a, button, input, select, textarea"))) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (bar.contains(el)) continue;
          // Only what is on screen right now: everything below the fold is fine.
          if (r.top > b.bottom || r.bottom < b.top) continue;
          if (r.left > limit || r.right < 0) continue;
          buried++;
        }
      }
    }

    return { wide: wide.slice(0, 4), buried };
  });
}

/* ------------------------------------------------------------------ sign-in */

/**
 * Plants a sign-in token and follows the real callback, the same way the HTTP smoke
 * sweep does — the raw token never leaves the server normally, only its hash is
 * stored, so this writes its own.
 */
/**
 * Screens only a department head can open. Swept in a second pass, as one, because
 * signing in as Finance and following the redirect to /admin would measure the wrong
 * page and report a pass — the silent no-op this whole file exists to catch.
 */
const HOD_PATHS = ["/team"];

/** Plants a sign-in token and follows the real callback. */
async function plant(page: Page, sql: postgres.Sql, userId: string) {
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  await sql`
    insert into sign_in_tokens (user_id, token_hash, expires_at)
    values (${userId}, ${hash}, now() + interval '10 minutes')`;
  await page.goto(`${BASE}/auth/callback?token=${token}`, { waitUntil: "domcontentloaded" });
}

/** The fest being swept, remembered so the second pass signs into the same one. */
let sweptFestId = "";

async function signIn(page: Page): Promise<Record<string, string>> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = postgres(url, { max: 1 });

  // The fest with the most in it, not the first one — a sweep against an empty fest
  // renders empty states everywhere and passes without testing anything.
  const [fest] = await sql`
    select f.id,
           (select count(*) from reimbursement_requests r where r.fest_id = f.id)
         + (select count(*) from tickets t where t.fest_id = f.id)
         + (select count(*) from line_items l where l.fest_id = f.id) as rows
      from fests f order by rows desc, f.created_at desc limit 1`;
  if (!fest) throw new Error("No fest — run pnpm db:seed");
  sweptFestId = String(fest.id);

  const [user] = await sql`
    select u.id from users u
     where u.fest_id = ${fest.id} and u.status = 'ACTIVE'
     order by (u.role = 'FINANCE_HOD') desc, u.is_super_admin desc, u.created_at
     limit 1`;
  if (!user) throw new Error("That fest has no active user");

  const one = async (q: postgres.PendingQuery<postgres.Row[]>) => String((await q)[0]?.id ?? "");
  const ids: Record<string, string> = {
    department: await one(sql`select id from departments where fest_id = ${fest.id} and kind = 'BUDGET' order by created_at limit 1`),
    lineItem: await one(sql`select id from line_items where fest_id = ${fest.id} and deleted_at is null order by created_at limit 1`),
    reimbursement: await one(sql`select id from reimbursement_requests where fest_id = ${fest.id} and deleted_at is null order by created_at limit 1`),
    vendor: await one(sql`select id from vendors where fest_id = ${fest.id} and deleted_at is null order by created_at limit 1`),
    vendorRequest: await one(sql`select id from vendor_requests where fest_id = ${fest.id} and deleted_at is null order by created_at limit 1`),
    ticket: await one(sql`select id from tickets where fest_id = ${fest.id} and deleted_at is null order by created_at limit 1`),
    channel: await one(sql`select c.id from channels c
                            join channel_members m on m.channel_id = c.id and m.user_id = ${user.id}
                           where c.fest_id = ${fest.id} order by c.created_at limit 1`),
  };

  await plant(page, sql, String(user.id));
  await sql.end();
  return ids;
}

/** Signs the same browser in as a department head, or says why it could not. */
async function signInAsHod(page: Page): Promise<boolean> {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  const [hod] = await sql`
    select id from users
     where fest_id = ${sweptFestId} and status = 'ACTIVE' and role = 'DEPT_HOD'
     order by created_at limit 1`;
  if (hod) await plant(page, sql, String(hod.id));
  await sql.end();
  return Boolean(hod);
}

/* ---------------------------------------------------------------------- run */

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

const ids = await signIn(page);

const fill = (p: string) => p.replace(/\{(\w+)\}/g, (_, k) => ids[k] ?? "");
const missing = Object.entries(ids).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  // Said out loud rather than silently skipped: a sweep that quietly drops the
  // detail screens is the same failure it exists to catch.
  console.log(`\n  \x1b[33mno rows for: ${missing.join(", ")} — those screens are not being checked. Run pnpm smoke first.\x1b[0m`);
}
const paths = (only ? [only] : PATHS)
  .map(fill)
  .filter((p) => !p.includes("//") && !p.endsWith("/"));

const rows: Row[] = [];
for (const path of paths) {
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w.width, height: w.height });
    try {
      const res = await page.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 20_000 });
      if (res && res.status() >= 400) {
        rows.push({
          path, width: w.name, overflowBy: 0, offenders: [], wide: [], buried: 0,
          error: `HTTP ${res.status()}`,
        });
        continue;
      }
      const { by, offenders } = await overflowAt(page, w.width);
      const { wide, buried } = await auditAt(page);
      rows.push({ path, width: w.name, overflowBy: by, offenders, wide, buried });
    } catch (e) {
      rows.push({
        path, width: w.name, overflowBy: 0, offenders: [], wide: [], buried: 0,
        error: (e as Error).message.slice(0, 80),
      });
    }
  }
}

if (!only || HOD_PATHS.includes(only)) {
  if (await signInAsHod(page)) {
    for (const path of HOD_PATHS) {
      paths.push(path);
      for (const w of WIDTHS) {
        await page.setViewportSize({ width: w.width, height: w.height });
        try {
          const res = await page.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 20_000 });
          if (res && res.status() >= 400) {
            rows.push({ path, width: w.name, overflowBy: 0, offenders: [], wide: [], buried: 0, error: `HTTP ${res.status()}` });
            continue;
          }
          const { by, offenders } = await overflowAt(page, w.width);
          const { wide, buried } = await auditAt(page);
          rows.push({ path, width: w.name, overflowBy: by, offenders, wide, buried });
        } catch (e) {
          rows.push({ path, width: w.name, overflowBy: 0, offenders: [], wide: [], buried: 0, error: (e as Error).message.slice(0, 80) });
        }
      }
    }
  } else {
    console.log(`\n  \x1b[33mno active department head in that fest — ${HOD_PATHS.join(", ")} is not being checked. Run pnpm smoke --keep first.\x1b[0m`);
  }
}

await browser.close();

/* -------------------------------------------------------------------- report */

const bad = rows.filter((r) => r.overflowBy > 1 || r.error || r.buried > 0);
const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);

console.log("");
for (const path of paths) {
  const mine = rows.filter((r) => r.path === path);
  const broken = mine.filter((r) => r.overflowBy > 1 || r.error || r.buried > 0);
  // Only worth saying once, and only where a phone has to read it.
  const swipes = mine.find((r) => r.width === "phone")?.wide ?? [];
  const mark = broken.length === 0 ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  const summary = broken.length === 0
    ? "\x1b[2mfits every width\x1b[0m"
    : broken.map((b) => `\x1b[31m${b.width} ${b.error ?? (b.buried > 0 && b.overflowBy <= 1 ? `${b.buried} under the tab bar` : `+${b.overflowBy}px`)}\x1b[0m`).join("  ");
  console.log(`  ${mark} ${pad(path, 26)} ${summary}`);

  for (const w of swipes) {
    console.log(`      \x1b[33m${pad("phone", 9)} swipe to read: ${w.content}px inside ${w.box}px  ${w.cls}\x1b[0m`);
    if (w.text) console.log(`      \x1b[2m${" ".repeat(9)}   “${w.text}”\x1b[0m`);
  }

  for (const b of broken) {
    for (const o of b.offenders) {
      console.log(`      \x1b[2m${pad(b.width, 9)} ${o.tag} ${o.width}px  ${o.cls}\x1b[0m`);
      if (o.text) console.log(`      \x1b[2m${" ".repeat(9)}   “${o.text}”\x1b[0m`);
    }
  }
}

console.log("");
const swiping = new Set(rows.filter((r) => r.width === "phone" && r.wide.length > 0).map((r) => r.path));
console.log(
  `  ${rows.length} renders  ${rows.length - bad.length} fit`
  + (bad.length ? `  \x1b[31m${bad.length} broken\x1b[0m` : "")
  + (swiping.size ? `  \x1b[33m${swiping.size} need a sideways swipe on a phone\x1b[0m` : ""),
);
process.exit(bad.length > 0 ? 1 : 0);
