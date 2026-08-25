import { route } from "@/lib/api";
import { withdrawAllocationRequest } from "@/lib/services/allocations";

/** An HOD taking their own ask back. Anyone else wanting it gone declines it. */
export const DELETE = route<{ id: string }>(async ({ user, params }) =>
  withdrawAllocationRequest(user, params.id));
