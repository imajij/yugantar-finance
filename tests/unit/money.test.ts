import { describe, expect, test } from "vitest";
import {
  assertPaise, formatPaise, formatPaisePlain, paiseToRupees, percentOfPaise,
  rupeesToPaise, sumPaise, utilizationPct,
} from "@/lib/money";

describe("rupeesToPaise", () => {
  test("whole rupees, decimals, and formatted input", () => {
    expect(rupeesToPaise(1234)).toBe(123400);
    expect(rupeesToPaise("1234.50")).toBe(123450);
    expect(rupeesToPaise("1234.5")).toBe(123450);
    expect(rupeesToPaise("₹1,23,456.00")).toBe(12345600);
    expect(rupeesToPaise("-500.25")).toBe(-50025);
    expect(rupeesToPaise("0.01")).toBe(1);
  });

  test("rejects anything that isn't a two-decimal rupee amount", () => {
    for (const bad of ["1.234", "abc", "", "1,2.3.4", "1e5"]) {
      expect(() => rupeesToPaise(bad), bad).toThrow(TypeError);
    }
  });

  test("float cents that break naive parsing", () => {
    // 0.1 + 0.2 style errors never reach the database.
    expect(rupeesToPaise("0.10") + rupeesToPaise("0.20")).toBe(30);
    expect(rupeesToPaise("19.99") * 3).toBe(5997);
  });
});

describe("formatting", () => {
  test("Indian digit grouping with a ₹ prefix (9.1 rule 4)", () => {
    expect(formatPaise(12345600)).toBe("₹1,23,456.00");
    expect(formatPaise(100000000)).toBe("₹10,00,000.00");
    expect(formatPaise(0)).toBe("₹0.00");
    expect(formatPaise(-350000)).toBe("-₹3,500.00");
  });

  test("plain export cells carry no symbol", () => {
    expect(formatPaisePlain(12345600)).toBe("123456.00");
    expect(formatPaisePlain(1)).toBe("0.01");
  });

  test("formatting rejects non-integer paise loudly", () => {
    expect(() => formatPaise(1.5)).toThrow(TypeError);
    expect(() => assertPaise("100" as unknown)).toThrow(TypeError);
  });
});

describe("arithmetic", () => {
  test("sumPaise stays exact where floats would not", () => {
    expect(sumPaise([1, 2, 3])).toBe(6);
    expect(sumPaise([])).toBe(0);
    expect(() => sumPaise([1, 2.5])).toThrow(TypeError);
  });

  test("percentOfPaise rounds to the nearest paise", () => {
    expect(percentOfPaise(10000000, 50)).toBe(5000000); // 50% advance on ₹1,00,000
    expect(percentOfPaise(333, 33)).toBe(110);          // 109.89 → 110
  });

  test("paiseToRupees is for display only", () => {
    expect(paiseToRupees(12345600)).toBe(123456);
  });
});

describe("utilizationPct (6.2)", () => {
  test("(committed + spent) / allocated", () => {
    expect(utilizationPct(1350000, 1550000, 10000000)).toBe(29);
    expect(utilizationPct(0, 10000000, 10000000)).toBe(100);
  });

  test("an unallocated department is 0%, not NaN or Infinity", () => {
    expect(utilizationPct(500000, 500000, 0)).toBe(0);
  });

  test("over-utilization is reported, not clamped — HODs need to see it", () => {
    expect(utilizationPct(0, 12000000, 10000000)).toBe(120);
  });
});

