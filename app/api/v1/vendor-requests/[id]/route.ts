import { route } from "@/lib/api";
import { getVendorRequestDetail } from "@/lib/services/vendors";

export const GET = route<{ id: string }>(async ({ user, params }) =>
  getVendorRequestDetail(user, params.id),
);
