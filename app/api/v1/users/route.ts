import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { inviteUser, listUsers } from "@/lib/services/admin";

export const GET = route(async ({ user }) => ({ data: await listUsers(user) }));

const schema = z.object({
  name: z.string().min(2).max(120),
  email: z.email(),
  role: z.enum(["MEMBER", "DEPT_HOD", "FINANCE_HOD", "MANAGEMENT"]),
  department_id: z.uuid(),
  upi_id: z.string().max(80).nullish(),
  phone: z.string().max(20).nullish(),
  /** Only an administrator may set this; `inviteUser` enforces that. */
  is_super_admin: z.boolean().optional(),
});

export const POST = route(async ({ user, request }) => {
  const b = await parseBody(request, schema);
  return inviteUser(user, {
    name: b.name, email: b.email, role: b.role,
    departmentId: b.department_id, upiId: b.upi_id, phone: b.phone,
    isSuperAdmin: b.is_super_admin,
  });
});
