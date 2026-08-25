import { route } from "@/lib/api";
import { deleteCycle } from "@/lib/services/planning";

export const DELETE = route<{ id: string }>(async ({ user, params }) => deleteCycle(user, params.id));
