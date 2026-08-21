/**
 * PRD 5.1 permissions matrix and 5.2 segregation of duties.
 * 21.3: "a test proves each role gets 403 on every endpoint it must not use".
 */
import { describe, expect, test } from "vitest";
import { can, maskAccountNumber, satisfiesActorConstraints, type Actor, type Action, type Resource } from "@/lib/authz";

const FEST = "fest-1";
const TECH = "dept-tech";
const LOGISTICS = "dept-logistics";
const FINANCE_DEPT = "dept-finance";
const CORE = "dept-core";

const member: Actor = { id: "u-member", festId: FEST, role: "MEMBER", departmentId: TECH };
const hod: Actor = { id: "u-hod", festId: FEST, role: "DEPT_HOD", departmentId: TECH };
const otherHod: Actor = { id: "u-other-hod", festId: FEST, role: "DEPT_HOD", departmentId: LOGISTICS };
const finance: Actor = { id: "u-finance", festId: FEST, role: "FINANCE_HOD", departmentId: FINANCE_DEPT };
const mgmt: Actor = { id: "u-mgmt", festId: FEST, role: "MANAGEMENT", departmentId: CORE };

/** A resource owned by Tech, submitted by someone else. */
const techResource: Resource = { festId: FEST, departmentId: TECH, submitterId: "u-someone", submitterRole: "MEMBER" };

/** [action, resource, who may do it]. Anyone not listed must be refused. */
const MATRIX: [Action, Resource, Actor[]][] = [
  ["fest.view", { festId: FEST }, [member, hod, otherHod, finance, mgmt]],
  ["fest.settings.view", { festId: FEST }, [finance]],
  ["department.budget.view", techResource, [member, hod, finance, mgmt]],
  ["department.budget.view", { festId: FEST, departmentId: LOGISTICS }, [otherHod, finance, mgmt]],
  ["reimbursement.view", techResource, [hod, finance, mgmt]],
  ["reimbursement.create", { festId: FEST }, [member, hod, otherHod, finance, mgmt]],
  ["reimbursement.endorse", techResource, [hod, finance]],
  ["reimbursement.approve", techResource, [finance]],
  ["reimbursement.recordPayment", techResource, [mgmt]],
  ["reimbursement.hold", techResource, [mgmt]],
  ["lineItem.create", techResource, [hod, finance]],
  ["lineItem.edit", techResource, [hod, finance]],
  ["lineItem.close", techResource, [hod, finance]],
  ["lineItem.markReviewed", techResource, [finance]],
  ["lineItem.document.manage", techResource, [hod, finance]],
  ["fest.manage", { festId: FEST }, [finance]],
  ["department.manage", { festId: FEST }, [finance]],
  ["budget.transfer", { festId: FEST }, [finance]],
  ["income.view", { festId: FEST }, [finance, mgmt]],
  ["income.manage", { festId: FEST }, [finance]],
  ["vendor.view", { festId: FEST }, [hod, otherHod, finance, mgmt]],
  ["vendor.bankDetails.view", { festId: FEST }, [finance, mgmt]],
  ["vendorRequest.create", techResource, [hod, finance]],
  ["vendorRequest.approve", techResource, [finance]],
  ["vendorRequest.confirmDelivery", techResource, [hod, finance]],
  ["vendorRequest.recordPayment", techResource, [mgmt]],
  ["user.manage", { festId: FEST }, [finance]],
  ["expenseType.manage", { festId: FEST }, [finance]],
  ["flag.view", techResource, [hod, finance]],
  ["flag.resolve", techResource, [finance]],
  ["audit.view", techResource, [hod, finance, mgmt]],
  ["export.run", techResource, [hod, finance, mgmt]],
  ["ticket.create", { festId: FEST }, [member, hod, otherHod, finance, mgmt]],
  ["budgetReview.view", { festId: FEST }, [finance]],
];

const ALL = [member, hod, otherHod, finance, mgmt];

describe("permissions matrix (5.1)", () => {
  for (const [action, resource, allowed] of MATRIX) {
    test(`${action} — ${allowed.map((a) => a.role).join(", ") || "nobody"}`, () => {
      for (const actor of ALL) {
        const expected = allowed.includes(actor);
        expect(can(actor, action, resource), `${actor.id} → ${action}`).toBe(expected);
      }
    });
  }
});

describe("department scoping", () => {
  test("a Dept HOD cannot see another department's requests or line items", () => {
    const logistics = { festId: FEST, departmentId: LOGISTICS, submitterId: "u-x" };
    expect(can(hod, "reimbursement.view", logistics)).toBe(false);
    expect(can(hod, "lineItem.view", logistics)).toBe(false);
    expect(can(hod, "lineItem.edit", logistics)).toBe(false);
    expect(can(hod, "audit.view", logistics)).toBe(false);
  });

  test("a Member cannot see another department at all", () => {
    expect(can(member, "department.budget.view", { festId: FEST, departmentId: LOGISTICS })).toBe(false);
    expect(can(member, "lineItem.view", { festId: FEST, departmentId: LOGISTICS })).toBe(false);
  });

  test("a Member sees their own department read-only (7 in section 17)", () => {
    expect(can(member, "lineItem.view", { festId: FEST, departmentId: TECH })).toBe(true);
    expect(can(member, "lineItem.edit", { festId: FEST, departmentId: TECH })).toBe(false);
  });

  test("nothing crosses fests (18.2 rule 10)", () => {
    for (const actor of ALL) {
      expect(can(actor, "fest.view", { festId: "other-fest" })).toBe(false);
      expect(can(actor, "reimbursement.view", { festId: "other-fest", departmentId: TECH })).toBe(false);
    }
  });
});

describe("segregation of duties (5.2)", () => {
  const own = (actor: Actor): Resource => ({
    festId: FEST, departmentId: actor.departmentId, submitterId: actor.id, submitterRole: actor.role,
  });

  test("nobody endorses, approves, or pays their own request", () => {
    for (const actor of ALL) {
      expect(can(actor, "reimbursement.endorse", own(actor)), actor.role).toBe(false);
      expect(can(actor, "reimbursement.approve", own(actor)), actor.role).toBe(false);
      expect(can(actor, "reimbursement.recordPayment", own(actor)), actor.role).toBe(false);
    }
  });

  test("a Finance HOD's own request is approved by Management, not Finance", () => {
    const financeOwn: Resource = { festId: FEST, departmentId: FINANCE_DEPT, submitterId: finance.id, submitterRole: "FINANCE_HOD" };
    expect(can(finance, "reimbursement.approve", financeOwn)).toBe(false);
    expect(can(mgmt, "reimbursement.approve", financeOwn)).toBe(true);

    // Another Finance HOD may not approve it either — Management owns this route.
    const finance2: Actor = { ...finance, id: "u-finance-2" };
    expect(can(finance2, "reimbursement.approve", financeOwn)).toBe(false);
  });

  test("with two Finance HODs, either may approve a member's request", () => {
    const finance2: Actor = { ...finance, id: "u-finance-2" };
    expect(can(finance, "reimbursement.approve", techResource)).toBe(true);
    expect(can(finance2, "reimbursement.approve", techResource)).toBe(true);
  });

  test("Management may not originate or approve ordinary spend", () => {
    expect(can(mgmt, "reimbursement.approve", techResource)).toBe(false);
    expect(can(mgmt, "vendorRequest.create", techResource)).toBe(false);
    expect(can(mgmt, "vendorRequest.approve", techResource)).toBe(false);
    expect(can(mgmt, "lineItem.create", techResource)).toBe(false);
    expect(can(mgmt, "budget.transfer", { festId: FEST })).toBe(false);
  });

  test("a Finance HOD may not approve a vendor request they raised", () => {
    expect(can(finance, "vendorRequest.approve", { festId: FEST, departmentId: TECH, submitterId: finance.id })).toBe(false);
  });
});

describe("tickets", () => {
  const ticket: Resource = {
    festId: FEST, requestingDepartmentId: TECH, targetDepartmentId: LOGISTICS,
    requesterId: member.id, assigneeId: "u-logistics-member",
  };

  test("both departments and Management can see a ticket; an outsider cannot", () => {
    expect(can(member, "ticket.view", ticket)).toBe(true);
    expect(can(hod, "ticket.view", ticket)).toBe(true);
    expect(can(otherHod, "ticket.view", ticket)).toBe(true);
    expect(can(mgmt, "ticket.view", ticket)).toBe(true);
    const outsider: Actor = { id: "u-out", festId: FEST, role: "MEMBER", departmentId: "dept-cultural" };
    expect(can(outsider, "ticket.view", ticket)).toBe(false);
  });

  test("only the target department's HOD triages", () => {
    expect(can(otherHod, "ticket.triage", ticket)).toBe(true);
    expect(can(hod, "ticket.triage", ticket)).toBe(false);
    expect(can(member, "ticket.triage", ticket)).toBe(false);
    expect(can(mgmt, "ticket.triage", ticket)).toBe(false);
  });

  test("Finance HOD triages tickets addressed to Finance", () => {
    const toFinance: Resource = { ...ticket, targetDepartmentId: FINANCE_DEPT };
    expect(can(finance, "ticket.triage", toFinance)).toBe(true);
    expect(can(finance, "ticket.triage", ticket)).toBe(false);
  });

  test("the requester closes; a stranger does not", () => {
    expect(can(member, "ticket.close", ticket)).toBe(true);
    expect(can(hod, "ticket.close", ticket)).toBe(true);   // requesting dept HOD
    expect(can(otherHod, "ticket.close", ticket)).toBe(false);
  });
});

describe("actor constraints on transitions", () => {
  test("NOT_SUBMITTER blocks self-approval even when the role fits", () => {
    const r: Resource = { submitterId: finance.id };
    expect(satisfiesActorConstraints(["NOT_SUBMITTER"], finance, r)).toBe(false);
    expect(satisfiesActorConstraints(["NOT_SUBMITTER"], mgmt, r)).toBe(true);
  });

  test("ASSIGNEE and REQUESTER are per-person, not per-department", () => {
    const r: Resource = { assigneeId: "u-a", requesterId: "u-r" };
    expect(satisfiesActorConstraints(["ASSIGNEE"], { ...member, id: "u-a" }, r)).toBe(true);
    expect(satisfiesActorConstraints(["ASSIGNEE"], { ...member, id: "u-b" }, r)).toBe(false);
    expect(satisfiesActorConstraints(["REQUESTER"], { ...member, id: "u-r" }, r)).toBe(true);
  });

  test("TARGET_DEPT_HOD needs both the role and the department", () => {
    const r: Resource = { targetDepartmentId: LOGISTICS };
    expect(satisfiesActorConstraints(["TARGET_DEPT_HOD"], otherHod, r)).toBe(true);
    expect(satisfiesActorConstraints(["TARGET_DEPT_HOD"], hod, r)).toBe(false);
    expect(satisfiesActorConstraints(["TARGET_DEPT_HOD"], { ...otherHod, role: "MEMBER" }, r)).toBe(false);
  });
});

test("bank account numbers are masked to the last four", () => {
  expect(maskAccountNumber("123456789012")).toBe("••••9012");
  expect(maskAccountNumber("12")).toBe("••••");
  expect(maskAccountNumber(null)).toBe(null);
});
