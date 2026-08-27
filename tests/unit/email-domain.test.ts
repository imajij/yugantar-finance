/**
 * Who the college is (PRD 13).
 *
 * `ALLOWED_EMAIL_DOMAIN` is a list because a college is not one Workspace: Scaler
 * runs `sst.scaler.com` for the school and `scaler.com` for everybody else, and
 * both hold people who end up running a department.
 *
 * The property this file is really about is the one that is easy to get wrong in
 * the convenient direction. "Allow the whole organisation" is tempting to write as
 * a suffix match on `.scaler.com` — and that does not mean "the same organisation",
 * it means "anything anybody ever points at that name". Each domain is listed and
 * each is matched whole.
 */
import { afterEach, beforeEach, expect, test } from "vitest";
import { allowedEmailDomains, describeAllowedDomains, emailDomainAllowed } from "@/lib/clerk";

let saved: string | undefined;
beforeEach(() => { saved = process.env.ALLOWED_EMAIL_DOMAIN; });
afterEach(() => {
  if (saved === undefined) delete process.env.ALLOWED_EMAIL_DOMAIN;
  else process.env.ALLOWED_EMAIL_DOMAIN = saved;
});

const set = (value: string | undefined) => {
  if (value === undefined) delete process.env.ALLOWED_EMAIL_DOMAIN;
  else process.env.ALLOWED_EMAIL_DOMAIN = value;
};

test("both college domains are accepted", () => {
  set("sst.scaler.com,scaler.com");

  expect(emailDomainAllowed("student@sst.scaler.com")).toBe(true);
  expect(emailDomainAllowed("head@scaler.com")).toBe(true);
  expect(emailDomainAllowed("MixedCase@Scaler.com")).toBe(true);
});

test("a lookalike domain is not one of them", () => {
  set("sst.scaler.com,scaler.com");

  // The ones a suffix match would have let through.
  expect(emailDomainAllowed("attacker@notscaler.com")).toBe(false);
  expect(emailDomainAllowed("attacker@scaler.com.evil.net")).toBe(false);
  expect(emailDomainAllowed("attacker@evil-scaler.com")).toBe(false);
  // A subdomain nobody listed. `scaler.com` being allowed says nothing about what
  // hangs off it.
  expect(emailDomainAllowed("someone@mail.scaler.com")).toBe(false);
  expect(emailDomainAllowed("someone@gmail.com")).toBe(false);
});

test("the list tolerates how people actually write it", () => {
  set(" SST.Scaler.com , @scaler.com ,, ");
  expect(allowedEmailDomains()).toEqual(["sst.scaler.com", "scaler.com"]);
});

test("one domain still works, and unset still means no restriction", () => {
  set("sst.scaler.com");
  expect(emailDomainAllowed("student@sst.scaler.com")).toBe(true);
  expect(emailDomainAllowed("head@scaler.com")).toBe(false);
  expect(describeAllowedDomains()).toBe("sst.scaler.com");

  // Left empty, the domain check is off entirely — the invitation is then the only
  // gate, which is what it has always really been (see `emailDomainAllowed`).
  set(undefined);
  expect(allowedEmailDomains()).toEqual([]);
  expect(describeAllowedDomains()).toBeNull();
  expect(emailDomainAllowed("anyone@anywhere.example")).toBe(true);
});

test("the list reads as a sentence", () => {
  set("sst.scaler.com,scaler.com");
  expect(describeAllowedDomains()).toBe("sst.scaler.com or scaler.com");
});
