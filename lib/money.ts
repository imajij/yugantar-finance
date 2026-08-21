/**
 * Money is integer paise everywhere except display (PRD 18.2 rule 4).
 * Never use `number` arithmetic on rupees; never format outside this module.
 */

/** Paise are integers. Anything else is a bug we want to hear about loudly. */
export function assertPaise(v: unknown): asserts v is number {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) {
    throw new TypeError(`Expected integer paise, got ${String(v)}`);
  }
}

export function rupeesToPaise(rupees: string | number): number {
  const s = String(rupees).trim().replace(/[₹,\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) {
    throw new TypeError(`Not a rupee amount: ${rupees}`);
  }
  const neg = s.startsWith("-");
  const [whole, frac = ""] = (neg ? s.slice(1) : s).split(".");
  const paise = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return neg ? -paise : paise;
}

export function paiseToRupees(paise: number): number {
  assertPaise(paise);
  return paise / 100;
}

const inr = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** ₹1,23,456.00 — Indian grouping comes free from Intl. */
export function formatPaise(paise: number): string {
  assertPaise(paise);
  return inr.format(paise / 100);
}

/** For CSV/XLSX cells that want a bare number, not a symbol. */
export function formatPaisePlain(paise: number): string {
  assertPaise(paise);
  return (paise / 100).toFixed(2);
}

export function sumPaise(values: readonly number[]): number {
  let total = 0;
  for (const v of values) {
    assertPaise(v);
    total += v;
  }
  return total;
}

/** Percentage of an amount, rounded to the nearest paise. Used for vendor advances. */
export function percentOfPaise(paise: number, percent: number): number {
  assertPaise(paise);
  return Math.round((paise * percent) / 100);
}

/** Utilization % as a number 0..n, one decimal. Allocated 0 → 0. */
export function utilizationPct(committedPaise: number, spentPaise: number, allocatedPaise: number): number {
  assertPaise(committedPaise);
  assertPaise(spentPaise);
  assertPaise(allocatedPaise);
  if (allocatedPaise === 0) return 0;
  return Math.round(((committedPaise + spentPaise) / allocatedPaise) * 1000) / 10;
}
