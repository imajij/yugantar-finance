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

/**
 * The platform administrator, deliberately a Member.
 *
 * The flag grants oversight — the audit log, the close-out pack, appointing other
 * administrators — and never the authority to move money. Making the fixture a
 * Member is what lets the matrix below prove that: they appear in the oversight rows
 * and in none of the spending ones.
 */
const superAdmin: Actor = {
  id: "u-super", festId: FEST, role: "MEMBER", departmentId: TECH, isSuperAdmin: true,
};

/** A resource owned by Tech, submitted by someone else. */
const techResource: Resource = { festId: FEST, departmentId: TECH, submitterId: "u-someone", submitterRole: "MEMBER" };

/** [action, resource, who may do it]. Anyone not listed must be refused. */
const MATRIX: [Action, Resource, Actor[]][] = [
  ["fest.view", { festId: FEST }, [member, hod, otherHod, finance, mgmt, superAdmin]],
  ["fest.settings.view", { festId: FEST }, [finance]],
  ["department.budget.view", techResource, [hod, finance, mgmt, superAdmin]],
  // Every department, not just their own — that is the point of the flag.
  ["department.budget.view", { festId: FEST, departmentId: LOGISTICS }, [otherHod, finance, mgmt, superAdmin]],
  ["lineItem.view", techResource, [hod, finance, mgmt, superAdmin]],
  ["lineItem.spendAgainst", techResource, [member, hod, finance, mgmt, superAdmin]],
  ["reimbursement.view", techResource, [hod, finance, mgmt]],
  ["reimbursement.create", { festId: FEST }, [member, hod, otherHod, finance, mgmt, superAdmin]],
  ["reimbursement.endorse", techResource, [hod, finance]],
  ["reimbursement.approve", techResource, [finance]],
  ["reimbursement.recordPayment", techResource, [mgmt]],
  ["reimbursement.hold", techResource, [mgmt]],
  // An administrator breaks down any department's allocation, the same way they read
  // any department's numbers. The cap still binds them — that is arithmetic, not a role.
  ["lineItem.create", techResource, [hod, finance, superAdmin]],
  ["lineItem.edit", techResource, [hod, finance, superAdmin]],
  ["lineItem.close", techResource, [hod, finance, superAdmin]],
  ["lineItem.markReviewed", techResource, [finance]],
  ["lineItem.document.manage", techResource, [hod, finance, superAdmin]],
  ["lineItem.create", { festId: FEST, departmentId: LOGISTICS }, [otherHod, finance, superAdmin]],
  ["fest.manage", { festId: FEST }, [finance]],
  ["department.manage", { festId: FEST }, [finance]],
  ["budget.transfer", { festId: FEST }, [finance, superAdmin]],
  ["income.view", { festId: FEST }, [finance, mgmt, superAdmin]],
  ["income.manage", { festId: FEST }, [finance]],
  ["vendor.view", { festId: FEST }, [hod, otherHod, finance, mgmt, superAdmin]],
  ["vendor.bankDetails.view", { festId: FEST }, [finance, mgmt]],
  ["vendorRequest.create", techResource, [hod, finance]],
  ["vendorRequest.approve", techResource, [finance]],
  ["vendorRequest.confirmDelivery", techResource, [hod, finance]],
  // Management or the Finance HOD (Finance even on its own — 5.2 exception).
  ["vendorRequest.recordPayment", techResource, [finance, mgmt]],
  // The Department expenses section: Finance adds spend to any department's budget.
  ["expense.forAnyDepartment", { festId: FEST }, [finance]],
  ["expense.forAnyDepartment", { festId: FEST, departmentId: LOGISTICS }, [finance]],
  ["user.manage", { festId: FEST }, [finance]],
  ["expenseType.manage", { festId: FEST }, [finance]],
  ["flag.view", techResource, [hod, finance, superAdmin]],
  ["flag.resolve", techResource, [finance]],
  // Raising a concern is wider than clearing one: whoever notices is rarely whoever
  // resolves it. A Member is not on this list — 8.3 is an oversight tool.
  ["flag.raise", techResource, [hod, otherHod, finance, mgmt, superAdmin]],
  // Oversight answers to the flag, not to a role.
  ["audit.view", techResource, [superAdmin]],
  ["closeOut.view", { festId: FEST }, [superAdmin]],
  ["superAdmin.manage", { festId: FEST }, [superAdmin]],
  // Per-kind exports keep 20.12's rules: Management needs the payment batch, an HOD
  // their own department's statement.
  ["export.run", techResource, [hod, finance, mgmt, superAdmin]],
  ["ticket.create", { festId: FEST }, [member, hod, otherHod, finance, mgmt, superAdmin]],
  ["budgetReview.view", { festId: FEST }, [finance]],
  // An HOD asks for their own department's budget and nobody else's; the ask is not
  // the money, so deciding it stays with whoever may transfer (5.2).
  ["allocationRequest.create", techResource, [hod]],
  ["allocationRequest.create", { festId: FEST, departmentId: LOGISTICS }, [otherHod]],
  ["allocationRequest.decide", { festId: FEST }, [finance, superAdmin]],
  ["allocationRequest.view", techResource, [member, hod, finance, mgmt, superAdmin]],
  // Labels, projects and cycles shape a board; they decide nothing about money.
  ["ticket.plan", { festId: FEST }, [hod, otherHod, finance, mgmt, superAdmin]],
  // Editing a vendor is wider than retiring one: a vendor carries a payment trail.
  ["vendor.manage", { festId: FEST }, [hod, otherHod, finance]],
  ["vendor.delete", { festId: FEST }, [finance, superAdmin]],
  // A channel's audience is its membership, so with nobody a member only the
  // administrator gets in — including the Finance HOD, who sees every rupee.
  ["channel.view", techResource, [superAdmin]],
  ["channel.post", techResource, []],
  ["channel.oversee", { festId: FEST }, [superAdmin]],
  ["channel.manage", techResource, [hod, superAdmin]],
  ["channel.manage", { festId: FEST, departmentId: FINANCE_DEPT }, [finance, superAdmin]],
];

const ALL = [member, hod, otherHod, finance, mgmt, superAdmin];

describe("a channel's audience is its membership", () => {
  const inIt = { ...techResource, isChannelMember: true };

  test("a member reads and posts; nobody else does either", () => {
    expect(can(member, "channel.view", inIt)).toBe(true);
    expect(can(member, "channel.post", inIt)).toBe(true);
    // Same resource, no membership row: refused, whatever the role.
    expect(can(member, "channel.view", techResource)).toBe(false);
    expect(can(finance, "channel.view", techResource)).toBe(false);
    expect(can(mgmt, "channel.view", techResource)).toBe(false);
    expect(can(otherHod, "channel.view", techResource)).toBe(false);
  });

  test("an administrator reads without membership, and still cannot post", () => {
    // The whole shape of the feature in two lines: oversight is a read, and saying
    // something means joining, which puts your name in the member list.
    expect(can(superAdmin, "channel.view", techResource)).toBe(true);
    expect(can(superAdmin, "channel.post", techResource)).toBe(false);
    expect(can(superAdmin, "channel.post", { ...techResource, isChannelMember: true })).toBe(true);
  });

  test("an absent membership flag means absent, not unknown", () => {
    // A caller who forgets to look membership up is refused rather than admitted:
    // `undefined` must never read as permission.
    expect(can(member, "channel.view", { festId: FEST, departmentId: TECH })).toBe(false);
    expect(can(member, "channel.view", { festId: FEST, departmentId: TECH, isChannelMember: false })).toBe(false);
  });

  test("membership from another fest is not membership", () => {
    expect(can(member, "channel.view", { festId: "fest-2", departmentId: TECH, isChannelMember: true })).toBe(false);
  });
});

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

  test("the administrator flag grants oversight and no spending authority", () => {
    // What it does grant.
    expect(can(superAdmin, "audit.view", techResource)).toBe(true);
    expect(can(superAdmin, "closeOut.view", { festId: FEST })).toBe(true);
    expect(can(superAdmin, "superAdmin.manage", { festId: FEST })).toBe(true);

    // Reading every department, and the reports built from it.
    expect(can(superAdmin, "export.run", techResource)).toBe(true);
    expect(can(superAdmin, "income.view", { festId: FEST })).toBe(true);
    expect(can(superAdmin, "vendor.view", { festId: FEST })).toBe(true);
    expect(can(superAdmin, "department.budget.view", { festId: FEST, departmentId: LOGISTICS })).toBe(true);

    // Setting each department's budget. It still moves as an audited transfer.
    expect(can(superAdmin, "budget.transfer", { festId: FEST })).toBe(true);

    // What it must not grant. This administrator is a Member, and stays one: 5.2's
    // segregation turns on the role, and oversight is not a way around it.
    for (const action of [
      "reimbursement.approve", "reimbursement.endorse", "reimbursement.recordPayment",
      "reimbursement.hold", "fest.manage", "user.manage", "income.manage", "flag.resolve",
      "lineItem.markReviewed", "vendorRequest.approve", "department.manage",
      "vendor.bankDetails.view",
    ] as const) {
      expect(can(superAdmin, action, techResource), action).toBe(false);
    }
  });

  test("a role alone never grants oversight, however senior", () => {
    for (const actor of [member, hod, otherHod, finance, mgmt]) {
      expect(can(actor, "audit.view", techResource), `${actor.id} audit`).toBe(false);
      expect(can(actor, "closeOut.view", { festId: FEST }), `${actor.id} close-out`).toBe(false);
      expect(can(actor, "superAdmin.manage", { festId: FEST }), `${actor.id} manage`).toBe(false);
    }
  });

  test("an administrator on another fest is still nobody here", () => {
    const elsewhere: Actor = { ...superAdmin, festId: "fest-2" };
    expect(can(elsewhere, "audit.view", techResource)).toBe(false);
    expect(can(elsewhere, "closeOut.view", { festId: FEST })).toBe(false);
  });

  test("a Member cannot see another department at all", () => {
    expect(can(member, "department.budget.view", { festId: FEST, departmentId: LOGISTICS })).toBe(false);
    expect(can(member, "lineItem.view", { festId: FEST, departmentId: LOGISTICS })).toBe(false);
  });

  /**
   * A Member spends out of a budget without being shown it. What a department was
   * allocated, what it has committed and how close it is to its cap are the head's
   * business and Finance's — a Member who can read the balance is one who starts
   * deciding whether to claim based on it.
   */
  test("a Member cannot read their own department's budget", () => {
    expect(can(member, "lineItem.view", { festId: FEST, departmentId: TECH })).toBe(false);
    expect(can(member, "department.budget.view", { festId: FEST, departmentId: TECH })).toBe(false);
    expect(can(member, "lineItem.edit", { festId: FEST, departmentId: TECH })).toBe(false);
  });

  /**
   * The half a Member does keep. Choosing which pot a receipt is charged to is not
   * reading that pot's balance, and it has to survive the rule above or a Member
   * could not file a claim at all.
   */
  test("a Member may still file against their own department, and only their own", () => {
    expect(can(member, "lineItem.spendAgainst", { festId: FEST, departmentId: TECH })).toBe(true);
    expect(can(member, "lineItem.spendAgainst", { festId: FEST, departmentId: LOGISTICS })).toBe(false);
  });

  test("Finance and Management may file anywhere — their own departments hold no budget", () => {
    // 5.1: every role may claim money they personally spent. Finance sits in the
    // Finance department and Management in Core, neither of which has line items,
    // so an own-department rule would leave them unable to claim at all.
    for (const actor of [finance, mgmt]) {
      expect(can(actor, "lineItem.spendAgainst", { festId: FEST, departmentId: TECH })).toBe(true);
    }
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
      // Vendor requests are the one exception, and only for the Finance HOD (below).
      if (actor.role !== "FINANCE_HOD") {
        expect(can(actor, "vendorRequest.recordPayment", own(actor)), actor.role).toBe(false);
      }
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

  /*
   * By decision (5.2): Finance raises vendor payments for any department, and with
   * one Finance HOD nobody else could approve them. So Finance may approve and pay
   * its own — the service demands a note on the approval, and Management is told.
   * Nobody else gains anything from this.
   */
  test("a Finance HOD may approve and pay a vendor request they raised", () => {
    const financeOwn = { festId: FEST, departmentId: TECH, submitterId: finance.id };
    expect(can(finance, "vendorRequest.approve", financeOwn)).toBe(true);
    expect(can(finance, "vendorRequest.recordPayment", financeOwn)).toBe(true);
    const hodOwn = { festId: FEST, departmentId: TECH, submitterId: hod.id };
    expect(can(hod, "vendorRequest.approve", hodOwn)).toBe(false);
    expect(can(hod, "vendorRequest.recordPayment", hodOwn)).toBe(false);
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
