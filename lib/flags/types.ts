/** PRD 8.2 — each rule is a pure function `(entity, context) → Flag | null`. */
export type Severity = "HIGH" | "MEDIUM" | "LOW";

export interface FlagResult {
  rule: string;
  severity: Severity;
  /** Plain language, with the numbers in it (8.3). */
  explanation: string;
}

export interface Thresholds {
  F2_abs_paise: number;
  F2_pct: number;
  F4_before_days: number;
  F4_after_days: number;
  F6_count: number;
  F6_total_paise: number;
  F8_pct: number;
  F10_threshold_paise: number;
  F11_multiplier: number;
  F11_min_samples: number;
  F14_pct: number;
  income_followup_days: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  F2_abs_paise: 5000, F2_pct: 5,
  F4_before_days: 60, F4_after_days: 15,
  F6_count: 5, F6_total_paise: 2500000,
  F8_pct: 50, F10_threshold_paise: 1000000,
  F11_multiplier: 3, F11_min_samples: 10,
  F14_pct: 20,
  income_followup_days: 30,
};

export function thresholdsFrom(settings: unknown): Thresholds {
  const raw = (settings as { flag_thresholds?: Partial<Thresholds> } | null)?.flag_thresholds ?? {};
  return { ...DEFAULT_THRESHOLDS, ...raw };
}
