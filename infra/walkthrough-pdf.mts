/**
 * Renders `docs/walkthrough.html` to a PDF handout.
 *
 * The page is dark on screen because the product it walks through is; the print
 * stylesheet flips it to the light variant, which is that same design system's own
 * rule — emails and printed exports are light regardless (PRD 9.1 rule 6). So this
 * asks Chromium for the print media rather than screenshotting the screen version,
 * and a handout comes off the printer legible instead of drinking a cartridge.
 *
 *   pnpm walkthrough:pdf
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { chromium } from "playwright";

const src = resolve(process.argv[2] ?? "docs/walkthrough.html");
const out = resolve(process.argv[3] ?? "docs/Yugaantar-Walkthrough.pdf");

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(pathToFileURL(src).href, { waitUntil: "networkidle" });

// Every answer belongs in a printed handout, whether or not it is open on screen.
await page.evaluate(() => {
  for (const d of Array.from(document.querySelectorAll("details"))) d.setAttribute("open", "");
});
// The typefaces arrive over the network; without waiting, the PDF sets in a fallback.
await page.evaluate(() => document.fonts.ready);
await page.emulateMedia({ media: "print" });
await page.waitForTimeout(500);

await page.pdf({
  path: out,
  format: "A4",
  printBackground: true,
  preferCSSPageSize: true,
  displayHeaderFooter: true,
  headerTemplate: "<span></span>",
  footerTemplate:
    '<div style="width:100%;font-family:Lexend,sans-serif;font-size:7.5pt;color:#8a8c9c;'
    + 'padding:0 13mm;display:flex;justify-content:space-between">'
    + "<span>Yugaantar &rsquo;26 &middot; Finance &amp; Operations</span>"
    + '<span class="pageNumber"></span></div>',
});

await browser.close();
console.log(`wrote ${out}`);
process.exit(0);
