import { notFound as nf, redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { can } from "@/lib/authz";
import { PageTitle } from "@/components/ui";
import { VendorForm } from "./form";

export default async function NewVendorPage() {
  const user = await getSession();
  if (!user) redirect("/sign-in");
  if (!can(user, "vendor.manage", { festId: user.festId, departmentId: user.departmentId })) nf();

  return (
    <div className="max-w-xl">
      <PageTitle>Add a vendor</PageTitle>
      <VendorForm />
    </div>
  );
}
