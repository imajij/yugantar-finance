import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { updateFestSettings } from "@/lib/services/admin";

/** PRD 8.2 / 20.10 — the flag thresholds a Finance HOD tunes without a deploy. */
const schema = z.object({
  flag_thresholds: z.object({
    F2_abs_paise: z.number().int().min(0).optional(),
    F2_pct: z.number().int().min(0).max(100).optional(),
    F4_before_days: z.number().int().min(0).max(365).optional(),
    F4_after_days: z.number().int().min(0).max(365).optional(),
    F6_count: z.number().int().min(1).max(100).optional(),
    F6_total_paise: z.number().int().min(0).optional(),
    F8_pct: z.number().int().min(1).max(100).optional(),
    F10_threshold_paise: z.number().int().min(0).optional(),
    F11_multiplier: z.number().min(1).max(100).optional(),
    F11_min_samples: z.number().int().min(1).max(1000).optional(),
    F14_pct: z.number().int().min(0).max(1000).optional(),
    income_followup_days: z.number().int().min(1).max(365).optional(),
  }).optional(),
});

export const PATCH = route(async ({ user, request }) => {
  const b = await parseBody(request, schema);
  return updateFestSettings(user, b);
});
