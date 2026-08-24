/**
 * The one email template (PRD 10). Every notification is the same shape — what
 * happened, the numbers behind it, a link to the record, and who owns the next
 * action — so one template with slots beats a dozen near-identical ones.
 *
 * **Dark, matching the dashboard** (9.1 tokens, mirrored below). PRD 21.4 says emails
 * are light; the fest asked for the brand instead, and a sign-in link that looks
 * nothing like the thing it signs you into is its own small trust problem.
 *
 * Dark email is harder than dark web, and the differences drive most of what follows:
 *
 *   - **Colour goes on `bgcolor` attributes as well as CSS.** Outlook's Word renderer
 *     drops `background-color` on many elements. An attribute survives; a stylesheet
 *     rule may not, and a table that loses its background leaves dark text on white.
 *   - **Every text colour is explicit, on the element itself.** Inheritance is not
 *     reliable, and unstyled text defaults to near-black — invisible here.
 *   - **`color-scheme` is declared** so Apple Mail and iOS do not "helpfully" invert
 *     a design that is already dark.
 *   - **No CSS variables, no classes, no `<style>` block.** Gmail strips the head;
 *     everything is inline.
 *   - **A light-mode fallback is impossible to guarantee**, so the outermost surface
 *     is painted too: a client that ignores everything still shows dark-on-dark
 *     rather than dark-on-white.
 */

export interface EmailBlock {
  label: string;
  value: string;
}

/* The 9.1 tokens, as literals — `var()` does not survive an email client. */
const BG = "#06061f";        // --yg-bg, the landing/sign-in background
const SURFACE = "#1a1b2e";   // --yg-surface, cards
const BORDER = "#2a2b3d";    // --yg-surface-2
const LIME = "#d2fc3c";      // --yg-lime, the fest name
const YELLOW = "#eece00";    // --yg-yellow, the one important action
const ON_ACCENT = "#06061f"; // --yg-on-accent
const TEXT = "#ffffff";      // --yg-text
const SOFT = "#c0c0c0";      // --yg-text-soft
const MUTED = "#a0a0b0";     // --yg-text-muted

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

export function NotificationEmail({
  heading,
  body,
  blocks,
  url,
  actionLabel,
  footnote,
}: {
  heading: string;
  body?: string | null;
  blocks?: EmailBlock[];
  url: string | null;
  actionLabel?: string;
  footnote?: string;
}) {
  return (
    <html lang="en">
      {/* eslint-disable-next-line @next/next/no-head-element -- a standalone email document, not a Next page */}
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Tell the client this design is already dark, so it does not invert it. */}
        <meta name="color-scheme" content="dark" />
        <meta name="supported-color-schemes" content="dark" />
        <title>{heading}</title>
      </head>

      <body style={{ margin: 0, padding: 0, backgroundColor: BG, colorScheme: "dark" }}>
        {/* Preheader: the grey line a client shows next to the subject. Hidden in the
            body itself, or it would repeat the heading twice over. */}
        <div style={{
          display: "none", maxHeight: 0, overflow: "hidden", opacity: 0,
          color: "transparent", height: 0, width: 0,
        }}>
          {footnote ?? body ?? heading}
        </div>

        <table
          role="presentation"
          width="100%"
          cellPadding={0}
          cellSpacing={0}
          border={0}
          bgcolor={BG}
          style={{ backgroundColor: BG, padding: "24px 12px", width: "100%" }}
        >
          <tbody>
            <tr>
              <td align="center" bgcolor={BG} style={{ backgroundColor: BG }}>
                <table
                  role="presentation"
                  width="100%"
                  cellPadding={0}
                  cellSpacing={0}
                  border={0}
                  bgcolor={SURFACE}
                  style={{
                    maxWidth: 560,
                    backgroundColor: SURFACE,
                    border: `1px solid ${BORDER}`,
                    borderRadius: 12,
                    fontFamily: FONT,
                  }}
                >
                  <tbody>
                    {/* Masthead. The lime wordmark is the one piece of the app's
                        identity that has to survive into the inbox. */}
                    <tr>
                      <td
                        bgcolor={SURFACE}
                        style={{
                          backgroundColor: SURFACE,
                          padding: "18px 24px",
                          borderBottom: `1px solid ${BORDER}`,
                        }}
                      >
                        <span style={{
                          fontSize: 15, fontWeight: 700, color: LIME, letterSpacing: "-0.01em",
                        }}>
                          Yugaantar &rsquo;26
                        </span>
                        <span style={{ fontSize: 13, color: MUTED }}>
                          {" "}&middot; Finance &amp; Operations
                        </span>
                      </td>
                    </tr>

                    <tr>
                      <td bgcolor={SURFACE} style={{ backgroundColor: SURFACE, padding: "26px 24px 8px" }}>
                        <h1 style={{
                          margin: 0, fontSize: 20, lineHeight: "28px", color: TEXT,
                          fontWeight: 600, fontFamily: FONT,
                        }}>
                          {heading}
                        </h1>
                        {body ? (
                          <p style={{
                            margin: "12px 0 0", fontSize: 14, lineHeight: "22px", color: SOFT,
                          }}>
                            {body}
                          </p>
                        ) : null}
                      </td>
                    </tr>

                    {blocks?.length ? (
                      <tr>
                        <td bgcolor={SURFACE} style={{ backgroundColor: SURFACE, padding: "18px 24px 0" }}>
                          <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} border={0}>
                            <tbody>
                              {blocks.map((b) => (
                                <tr key={b.label}>
                                  <td style={{
                                    padding: "8px 0", fontSize: 13, color: MUTED,
                                    borderBottom: `1px solid ${BORDER}`, width: "42%",
                                  }}>
                                    {b.label}
                                  </td>
                                  <td style={{
                                    padding: "8px 0", fontSize: 13, color: TEXT,
                                    borderBottom: `1px solid ${BORDER}`,
                                    textAlign: "right", fontWeight: 600,
                                  }}>
                                    {b.value}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    ) : null}

                    {url ? (
                      <tr>
                        <td bgcolor={SURFACE} style={{ backgroundColor: SURFACE, padding: "24px 24px 4px" }}>
                          {/* Yellow is reserved for the one most important action on a
                              screen (9.1 rule 2), and an email has exactly one. The
                              button is a bgcolor'd cell rather than a styled anchor,
                              because Outlook will not paint a link's background. */}
                          <table role="presentation" cellPadding={0} cellSpacing={0} border={0}>
                            <tbody>
                              <tr>
                                <td bgcolor={YELLOW} style={{ backgroundColor: YELLOW, borderRadius: 8 }}>
                                  <a
                                    href={url}
                                    style={{
                                      display: "inline-block",
                                      padding: "12px 22px",
                                      color: ON_ACCENT,
                                      fontSize: 14,
                                      fontWeight: 700,
                                      fontFamily: FONT,
                                      textDecoration: "none",
                                      borderRadius: 8,
                                    }}
                                  >
                                    {actionLabel ?? "Open the record"}
                                  </a>
                                </td>
                              </tr>
                            </tbody>
                          </table>

                          {/* The same link in the open, for a client that will not
                              render the button and for anyone who wants to see where
                              it goes before following it. */}
                          <p style={{ margin: "14px 0 0", fontSize: 11, lineHeight: "17px", color: MUTED }}>
                            Or paste this into your browser:{" "}
                            <span style={{ color: SOFT, wordBreak: "break-all" }}>{url}</span>
                          </p>
                        </td>
                      </tr>
                    ) : null}

                    <tr>
                      <td bgcolor={SURFACE} style={{ backgroundColor: SURFACE, padding: "18px 24px 26px" }}>
                        {footnote ? (
                          <p style={{ margin: "0 0 12px", fontSize: 13, lineHeight: "20px", color: SOFT }}>
                            {footnote}
                          </p>
                        ) : null}
                        <p style={{ margin: 0, fontSize: 11, lineHeight: "17px", color: MUTED }}>
                          You are receiving this because of your role on the Yugaantar finance and
                          operations platform. Amounts are in rupees; the record is the source of truth.
                        </p>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>
      </body>
    </html>
  );
}
