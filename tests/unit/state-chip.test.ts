import { describe, expect, test } from "vitest";
import { MAPPED_STATES, chipStyle, stateLabel, toneFor } from "@/lib/state-chip";
import { REIMBURSEMENT_STATES, TICKET_STATES, VENDOR_STATES } from "@/lib/state-machines";

describe("state chips (9.1)", () => {
  test("every state in every machine has an explicit tone — no silent fallback", () => {
    const unmapped = [...REIMBURSEMENT_STATES, ...VENDOR_STATES, ...TICKET_STATES]
      .filter((s) => !MAPPED_STATES.has(s));
    expect(unmapped).toEqual([]);
  });

  test("tones follow the 9.1 table", () => {
    expect(toneFor("SUBMITTED")).toBe("waiting");
    expect(toneFor("IN_PROGRESS")).toBe("moving");
    expect(toneFor("APPROVED")).toBe("decided");
    expect(toneFor("PAID")).toBe("done");
    expect(toneFor("DECLINED")).toBe("bad");
    expect(toneFor("ON_HOLD")).toBe("stuck");
  });

  test("chips resolve to the semantic variables, never a brand colour", () => {
    const { color, backgroundColor } = chipStyle("BLOCKED");
    expect(color).toBe("var(--state-stuck-fg)");
    expect(backgroundColor).toBe("var(--state-stuck-bg)");
  });

  test("labels are human, and HOD keeps its capitals", () => {
    expect(stateLabel("HOD_ENDORSED")).toBe("HOD endorsed");
    expect(stateLabel("ADVANCE_PAID")).toBe("Advance paid");
    expect(stateLabel("PAID")).toBe("Paid");
  });
});
