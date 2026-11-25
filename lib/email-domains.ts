/**
 * Who may be invited, by address (PRD 13).
 *
 * Sign-in is an emailed one-time link to an address somebody has already been
 * invited on (`lib/auth.ts`). These helpers decide which addresses an invitation
 * may go to: the college's own domains, plus invited external Management users.
 */
import { env } from "@/lib/env";

/**
 * The college's domains, in order, from `ALLOWED_EMAIL_DOMAIN`.
 *
 * A list rather than one value, because a college is not one Workspace: Scaler
 * runs `sst.scaler.com` for the school and `scaler.com` for everybody else, and
 * both hold people who end up running a department.
 *
 * Listed explicitly rather than matched as a suffix. `endsWith(".scaler.com")`
 * would read as "the same organisation" and actually mean "anything anybody ever
 * points at that name" — which is not a rule you want standing between an
 * outsider and a fest's ledger.
 */
export const allowedEmailDomains = (): string[] =>
  (env("ALLOWED_EMAIL_DOMAIN") ?? "")
    .toLowerCase()
    .split(",")
    .map((d) => d.trim().replace(/^@/, ""))
    .filter(Boolean);

/** How to say the list out loud: "sst.scaler.com or scaler.com". */
export function describeAllowedDomains(): string | null {
  const domains = allowedEmailDomains();
  if (domains.length === 0) return null;
  if (domains.length === 1) return domains[0];
  return `${domains.slice(0, -1).join(", ")} or ${domains[domains.length - 1]}`;
}

/**
 * PRD 13 — sign-in is restricted to the college domains, with invited external
 * Management users as the documented exception. An invitation having been issued
 * is what makes an outside address acceptable, so the domain check is advisory and
 * the "were they invited" check is the real gate.
 */
export function emailDomainAllowed(email: string): boolean {
  const domains = allowedEmailDomains();
  if (domains.length === 0) return true;
  const address = email.toLowerCase();
  return domains.some((d) => address.endsWith(`@${d}`));
}
