import { redirect } from "next/navigation";
import { and, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { departments } from "@/db/schema";
import { getSession } from "@/lib/session";
import { PageTitle } from "@/components/ui";
import { TicketForm } from "./form";

export default async function NewTicketPage() {
  const user = await getSession();
  if (!user) redirect("/sign-in");

  // A ticket asks *another* department for work (schema enforces it too).
  const targets = await db
    .select({ id: departments.id, name: departments.name })
    .from(departments)
    .where(and(
      eq(departments.festId, user.festId),
      eq(departments.isActive, true),
      ne(departments.id, user.departmentId),
    ))
    .orderBy(departments.name);

  return (
    <div className="max-w-xl">
      <PageTitle>Ask a department</PageTitle>
      <TicketForm departments={targets} />
    </div>
  );
}
