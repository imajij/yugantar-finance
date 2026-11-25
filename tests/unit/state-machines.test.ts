/**
 * PRD 21.3 — every `from × action` pair, plus the segregation cases.
 * The tables themselves are data; these tests check the rules *about* the tables.
 */
import { describe, expect, test } from "vitest";
import {
  InvalidTransition, ValidationError, assertTransition, type Role, type Transition,
  REIMBURSEMENT_STATES, REIMBURSEMENT_ACTIONS, REIMBURSEMENT_TRANSITIONS, REIMBURSEMENT_TERMINAL,
  landingStateForSubmit, approverRoleFor,
  VENDOR_STATES, VENDOR_ACTIONS, VENDOR_TRANSITIONS, VENDOR_TERMINAL, landingStateAfterPayment,
  TICKET_STATES, TICKET_ACTIONS, TICKET_TRANSITIONS, TICKET_TERMINAL,
  LINE_ITEM_STATES, LINE_ITEM_ACTIONS, LINE_ITEM_TRANSITIONS,
} from "@/lib/state-machines";

import { rupeesToPaise as R } from "@/lib/money";

const ROLES: Role[] = ["MEMBER", "DEPT_HOD", "FINANCE_HOD", "MANAGEMENT"];

/** Any body value satisfies the `requires` check; we test missing-field separately. */
const fullBody = (t: Transition<string, string>) =>
  Object.fromEntries((t.requires ?? []).map((f) => [f, "x"]));

const machines = [
  { name: "reimbursement", states: REIMBURSEMENT_STATES, actions: REIMBURSEMENT_ACTIONS, table: REIMBURSEMENT_TRANSITIONS, terminal: REIMBURSEMENT_TERMINAL, start: "DRAFT" },
  { name: "vendor", states: VENDOR_STATES, actions: VENDOR_ACTIONS, table: VENDOR_TRANSITIONS, terminal: VENDOR_TERMINAL, start: "DRAFT" },
  { name: "ticket", states: TICKET_STATES, actions: TICKET_ACTIONS, table: TICKET_TRANSITIONS, terminal: TICKET_TERMINAL, start: "OPEN" },
  { name: "line-item", states: LINE_ITEM_STATES, actions: LINE_ITEM_ACTIONS, table: LINE_ITEM_TRANSITIONS, terminal: [], start: "OPEN" },
] as const;

for (const m of machines) {
  describe(m.name, () => {
    const allowed = new Map<string, Transition<string, string>>();
    for (const t of m.table) allowed.set(`${t.from}:${t.action}`, t as Transition<string, string>);

    test("every from × action pair is either in the table or rejected", () => {
      for (const from of m.states) {
        for (const action of m.actions) {
          const key = `${from}:${action}`;
          const entry = allowed.get(key);
          if (entry) {
            // At least one role may fire it, and no other role may.
            const accepting = ROLES.filter((role) => {
              try {
                assertTransition(m.table, from, action, role, fullBody(entry));
                return true;
              } catch (e) {
                if (e instanceof InvalidTransition) return false;
                throw e;
              }
            });
            expect(accepting, key).not.toHaveLength(0);
            const declared = new Set(m.table.filter((t) => t.from === from && t.action === action).flatMap((t) => t.roles));
            expect(new Set(accepting), key).toEqual(declared);
          } else {
            for (const role of ROLES) {
              expect(() => assertTransition(m.table, from, action, role, {}), key).toThrow(InvalidTransition);
            }
          }
        }
      }
    });

    test("terminal states never move on", () => {
      // Self-loops are allowed (RECORD_REFUND on CANCELLED, ESCALATE on REJECTED);
      // anything that changes the state is not.
      for (const from of m.terminal) {
        for (const t of m.table.filter((x) => x.from === from)) {
          expect(t.to, `${from}:${t.action}`).toBe("SAME");
        }
      }
    });

    test("missing required fields raise VALIDATION_ERROR, not a silent pass", () => {
      for (const t of m.table) {
        if (!t.requires?.length) continue;
        expect(() => assertTransition(m.table, t.from, t.action, t.roles[0], {}), `${t.from}:${t.action}`)
          .toThrow(ValidationError);
      }
    });

    test("every state is reachable from the start state", () => {
      const seen = new Set<string>([m.start]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const t of m.table) {
          if (!seen.has(t.from)) continue;
          const to = t.to === "SAME" || t.to === "PREVIOUS" ? t.from : t.to;
          if (!seen.has(to)) { seen.add(to); grew = true; }
        }
      }
      // NEEDS_INFO restores `previous_status`, so PREVIOUS edges add no new state.
      expect([...m.states].filter((s) => !seen.has(s))).toEqual([]);
    });
  });
}

describe("segregation of duties (PRD 5.2)", () => {
  test("a lone HOD skips endorsement on their own department's budget, and only there", () => {
    // Nobody endorses their own request, so the sole head of a department spending
    // its own allocation goes straight to HOD_ENDORSED (7.2).
    expect(landingStateForSubmit("DEPT_HOD", true, false)).toBe("HOD_ENDORSED");
    expect(landingStateForSubmit("FINANCE_HOD", true, false)).toBe("HOD_ENDORSED");

    // But an HOD spending *another* department's allocation must still be endorsed
    // by that department — skipping on role alone would be a way around it.
    expect(landingStateForSubmit("DEPT_HOD", false, false)).toBe("SUBMITTED");
    expect(landingStateForSubmit("FINANCE_HOD", false, false)).toBe("SUBMITTED");

    // A Member is endorsed wherever they spend.
    expect(landingStateForSubmit("MEMBER", true, false)).toBe("SUBMITTED");
    expect(landingStateForSubmit("MEMBER", false, false)).toBe("SUBMITTED");
    expect(landingStateForSubmit("MANAGEMENT", true, false)).toBe("SUBMITTED");
  });

  test("where a department has a second head, that head does the endorsing", () => {
    // 7.2 skips the step because the only eligible endorser is the submitter. That
    // stops being true the moment a department has more than one head, and a peer
    // reviewing it is the whole point of endorsement.
    expect(landingStateForSubmit("DEPT_HOD", true, true)).toBe("SUBMITTED");
    expect(landingStateForSubmit("FINANCE_HOD", true, true)).toBe("SUBMITTED");

    // A peer elsewhere changes nothing about a claim on another department.
    expect(landingStateForSubmit("DEPT_HOD", false, true)).toBe("SUBMITTED");
  });

  test("a Finance HOD's own reimbursement is approved by Management", () => {
    expect(approverRoleFor("FINANCE_HOD")).toBe("MANAGEMENT");
    expect(approverRoleFor("MEMBER")).toBe("FINANCE_HOD");
    expect(approverRoleFor("DEPT_HOD")).toBe("FINANCE_HOD");
  });

  test("approve, endorse and record-payment all carry a NOT_SUBMITTER constraint", () => {
    for (const action of ["ENDORSE", "APPROVE", "RECORD_PAYMENT"] as const) {
      const rows = REIMBURSEMENT_TRANSITIONS.filter((t) => t.action === action);
      expect(rows.length, action).toBeGreaterThan(0);
      for (const row of rows) expect(row.actor, `${row.from}:${action}`).toContain("NOT_SUBMITTER");
    }
  });

  test("Members can never endorse, approve, or record payment", () => {
    for (const action of ["ENDORSE", "APPROVE", "RECORD_PAYMENT"] as const) {
      for (const t of REIMBURSEMENT_TRANSITIONS.filter((x) => x.action === action)) {
        expect(t.roles, `${t.from}:${action}`).not.toContain("MEMBER");
      }
    }
  });

  test("Management can never approve a vendor request or release a balance", () => {
    for (const action of ["APPROVE", "RELEASE_BALANCE"] as const) {
      for (const t of VENDOR_TRANSITIONS.filter((x) => x.action === action)) {
        expect(t.roles, `${t.from}:${action}`).toEqual(["FINANCE_HOD"]);
      }
    }
  });

  /*
   * Vendor money goes out through Management or the Finance HOD, and nobody else.
   * Whether Finance may pay a request it raised is `can`'s question
   * (`vendorRequest.recordPayment`, 5.2's vendor exception), so there is no actor
   * constraint on these rows. A refund coming back stays Management's to record.
   *
   * If this fails, ask whether a third role just gained the ability to move money
   * out, not whether the assertion is inconvenient.
   */
  test("vendor money moves through Management or Finance, and nobody else", () => {
    for (const action of ["RECORD_ADVANCE", "RECORD_BALANCE", "RECORD_REMAINING"] as const) {
      const rows = VENDOR_TRANSITIONS.filter((x) => x.action === action);
      expect(rows.length, action).toBeGreaterThan(0);
      for (const t of rows) {
        expect([...t.roles].sort(), `${t.from}:${action}`).toEqual(["FINANCE_HOD", "MANAGEMENT"]);
      }
    }
    for (const t of VENDOR_TRANSITIONS.filter((x) => x.action === "RECORD_REFUND")) {
      expect(t.roles).toEqual(["MANAGEMENT"]);
    }
  });

  test("only a payment that settles moves a vendor request on", () => {
    const advance = (settled: boolean) => ({ kind: "ADVANCE" as const, settled });
    const balance = (settled: boolean) => ({ kind: "BALANCE" as const, settled });
    expect(landingStateAfterPayment("APPROVED", advance(true), R(24000))).toBe("ADVANCE_PAID");
    expect(landingStateAfterPayment("APPROVED", advance(false), R(30000))).toBe("APPROVED");
    expect(landingStateAfterPayment("DELIVERED", advance(true), R(24000))).toBe("DELIVERED");
    expect(landingStateAfterPayment("BALANCE_APPROVED", balance(false), R(4000))).toBe("BALANCE_APPROVED");
    // A settled balance with the advance still part-paid is not the end of it.
    expect(landingStateAfterPayment("BALANCE_APPROVED", balance(true), R(6000))).toBe("BALANCE_APPROVED");
    expect(landingStateAfterPayment("BALANCE_APPROVED", advance(true), 0)).toBe("CLOSED");
  });

  /**
   * Reimbursement payment has exactly one documented exception, and this pins it to
   * exactly that shape.
   *
   * 5.2 pays a Management user's own claim from a *different* Management user, and
   * where the fest has only one, from the Finance HOD with a note. So Finance is on
   * the table — and nobody else is, `NOT_SUBMITTER` still holds, and the narrowing
   * to that one case lives in `can` (`reimbursement.recordPayment`), which is where
   * 18.2 rule 6 says segregation belongs.
   *
   * If this fails, the question to ask is whether a *third* role just gained the
   * ability to move money out, not whether the assertion is inconvenient.
   */
  test("reimbursement payment is Management's, with only 5.2's Finance fallback", () => {
    const paying = REIMBURSEMENT_TRANSITIONS.filter((x) => x.action === "RECORD_PAYMENT");
    expect(paying.length).toBeGreaterThan(0);
    for (const t of paying) {
      expect([...t.roles].sort()).toEqual(["FINANCE_HOD", "MANAGEMENT"]);
      expect(t.actor).toContain("NOT_SUBMITTER");
    }
  });
});
