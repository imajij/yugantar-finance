/**
 * The one email template (PRD 10). Every notification is the same shape — what
 * happened, the numbers behind it, a link to the record, and who owns the next
 * action — so one template with slots beats a dozen near-identical ones.
 *
 * Table layout and inline styles: Outlook ignores <div> layout and <style> blocks.
 * Light theme always (PRD 21.4), independent of the app's dark shell.
 */

export interface EmailBlock {
  label: string;
  value: string;
}

const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const LINE = "#e4e4e4";
const LIME = "#c3f53c";

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
        <title>{heading}</title>
      </head>
      <body style={{ margin: 0, padding: 0, backgroundColor: "#f5f5f3" }}>
        <table
          role="presentation"
          width="100%"
          cellPadding={0}
          cellSpacing={0}
          style={{ backgroundColor: "#f5f5f3", padding: "24px 12px" }}
        >
          <tbody>
            <tr>
              <td align="center">
                <table
                  role="presentation"
                  width="100%"
                  cellPadding={0}
                  cellSpacing={0}
                  style={{
                    maxWidth: 560,
                    backgroundColor: "#ffffff",
                    border: `1px solid ${LINE}`,
                    borderRadius: 10,
                    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
                  }}
                >
                  <tbody>
                    <tr>
                      <td style={{ padding: "18px 24px", borderBottom: `1px solid ${LINE}` }}>
                        <span style={{ fontSize: 15, fontWeight: 700, color: INK, letterSpacing: "-0.01em" }}>
                          Yugaantar &rsquo;26
                        </span>
                        <span style={{ fontSize: 13, color: MUTED }}> &middot; Finance &amp; Operations</span>
                      </td>
                    </tr>

                    <tr>
                      <td style={{ padding: "24px 24px 8px" }}>
                        <h1 style={{ margin: 0, fontSize: 19, lineHeight: "26px", color: INK, fontWeight: 600 }}>
                          {heading}
                        </h1>
                        {body ? (
                          <p style={{ margin: "12px 0 0", fontSize: 14, lineHeight: "22px", color: "#3d3d3d" }}>
                            {body}
                          </p>
                        ) : null}
                      </td>
                    </tr>

                    {blocks?.length ? (
                      <tr>
                        <td style={{ padding: "16px 24px 0" }}>
                          <table role="presentation" width="100%" cellPadding={0} cellSpacing={0}>
                            <tbody>
                              {blocks.map((b) => (
                                <tr key={b.label}>
                                  <td
                                    style={{
                                      padding: "7px 0",
                                      fontSize: 13,
                                      color: MUTED,
                                      borderBottom: `1px solid ${LINE}`,
                                      width: "42%",
                                    }}
                                  >
                                    {b.label}
                                  </td>
                                  <td
                                    style={{
                                      padding: "7px 0",
                                      fontSize: 13,
                                      color: INK,
                                      borderBottom: `1px solid ${LINE}`,
                                      textAlign: "right",
                                      fontWeight: 600,
                                    }}
                                  >
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
                        <td style={{ padding: "24px 24px 4px" }}>
                          <a
                            href={url}
                            style={{
                              display: "inline-block",
                              padding: "11px 20px",
                              backgroundColor: LIME,
                              color: INK,
                              fontSize: 14,
                              fontWeight: 600,
                              textDecoration: "none",
                              borderRadius: 7,
                            }}
                          >
                            {actionLabel ?? "Open the record"}
                          </a>
                        </td>
                      </tr>
                    ) : null}

                    <tr>
                      <td style={{ padding: "18px 24px 24px" }}>
                        {footnote ? (
                          <p style={{ margin: "0 0 10px", fontSize: 13, color: "#3d3d3d" }}>{footnote}</p>
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
