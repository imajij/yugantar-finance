import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { createCycle, listCycles } from "@/lib/services/planning";

/** A cycle is a fixed window everybody plans against — "Setup week", "Fest days". */
export const GET = route(async ({ user }) => ({ data: await listCycles(user) }));

const schema = z.object({
  name: z.string().min(2).max(60),
  starts_on: z.iso.date(),
  ends_on: z.iso.date(),
});

export const POST = route(async ({ user, request }) => {
  const b = await parseBody(request, schema);
  return createCycle(user, { name: b.name, startsOn: b.starts_on, endsOn: b.ends_on });
});
