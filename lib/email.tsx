/**
 * Email delivery (PRD 10, 18.1). Resend over its REST API — no SDK, so the only
 * dependency is `fetch`.
 *
 * Every notification row is written first and sent second: `notify()` records the
 * IN_APP row inside the caller's transaction, then `flushOutbox()` sends the EMAIL
 * rows after that transaction commits. A send that fails leaves `sent_at` null,
 * so the nightly sweep retries it rather than losing the message.
 *
 * Emails are light-themed regardless of the app's dark theme (PRD 21.4).
 */
import { NotificationEmail, type EmailBlock } from "@/emails/notification";

export const emailConfigured = () => Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);

export interface EmailMessage {
  to: string;
  subject: string;
  heading: string;
  body?: string | null;
  /** "Open RB-0231" — every email links to the record (PRD 21.5). */
  actionLabel?: string;
  actionPath?: string;
  /** "Waiting on: Finance HOD" — every email states the next action and who owns it. */
  footnote?: string;
  blocks?: EmailBlock[];
}

export const appUrl = () => (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");

export async function renderEmail(message: EmailMessage): Promise<{ html: string; text: string }> {
  const url = message.actionPath ? `${appUrl()}${message.actionPath}` : null;

  // Loaded lazily: Next refuses a static `react-dom/server` import in the server
  // bundle, and an email is the one thing here that genuinely renders to a string.
  const { renderToStaticMarkup } = await import("react-dom/server");
  const html = `<!doctype html>${renderToStaticMarkup(
    <NotificationEmail {...message} url={url} />,
  )}`;

  const text = [
    message.heading,
    message.body,
    ...(message.blocks ?? []).map((b) => `${b.label}: ${b.value}`),
    url ? `${message.actionLabel ?? "Open"}: ${url}` : null,
    message.footnote,
  ]
    .filter(Boolean)
    .join("\n\n");

  return { html, text };
}

/**
 * Sends one email. Returns false rather than throwing: a notification is already
 * durably stored, and a failed send must never roll back the write that caused it.
 */
export async function sendEmail(message: EmailMessage): Promise<boolean> {
  const { html, text } = await renderEmail(message);

  if (!emailConfigured()) {
    // Development and tests: the row stays unsent and the body is visible in the log.
    console.info(`[email:dry-run] to=${message.to} subject=${message.subject}`);
    return false;
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM,
        to: [message.to],
        subject: message.subject,
        html,
        text,
      }),
    });
    if (!response.ok) {
      console.error(`[email] resend ${response.status}: ${await response.text()}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error("[email] send failed", error);
    return false;
  }
}
