import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { expenseTypes } from "@/db/schema";
import { parseBody, parseQuery, route } from "@/lib/api";
import { createExpenseType } from "@/lib/services/admin";

export const GET = route(async ({ user, request }) => {
  const q = parseQuery(request, z.object({ include_inactive: z.enum(["0", "1"]).optional() }));
  return {
    data: await db.select().from(expenseTypes)
      .where(and(
        eq(expenseTypes.festId, user.festId),
        q.include_inactive === "1" ? undefined : eq(expenseTypes.isActive, true),
      ))
      .orderBy(asc(expenseTypes.sortOrder), asc(expenseTypes.name)),
  };
});

export const POST = route(async ({ user, request }) => {
  const b = await parseBody(request, z.object({ name: z.string().min(2).max(80) }));
  return createExpenseType(user, b.name);
});
