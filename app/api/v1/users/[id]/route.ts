import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { updateUser } from "@/lib/services/admin";

const schema = z.object({
  name: z.string().min(2).max(120).optional(),
  role: z.enum(["MEMBER", "DEPT_HOD", "FINANCE_HOD", "MANAGEMENT"]).optional(),
  department_id: z.uuid().optional(),
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
  upi_id: z.string().max(80).nullish(),
  phone: z.string().max(20).nullish(),
});

export const PATCH = route<{ id: string }>(async ({ user, params, request }) => {
  const b = await parseBody(request, schema);
  return updateUser(user, params.id, {
    name: b.name, role: b.role, departmentId: b.department_id,
    status: b.status, upiId: b.upi_id, phone: b.phone,
  });
});
