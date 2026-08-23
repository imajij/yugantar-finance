import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { setExpenseTypeActive } from "@/lib/services/admin";

export const PATCH = route<{ id: string }>(async ({ user, params, request }) => {
  const b = await parseBody(request, z.object({ is_active: z.boolean() }));
  return setExpenseTypeActive(user, params.id, b.is_active);
});
