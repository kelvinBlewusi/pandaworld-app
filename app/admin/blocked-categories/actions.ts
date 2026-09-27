"use server";

import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { isAdmin } from "@/lib/auth/is-admin";
import { unblockCategory } from "@/lib/jumia/unlistable-categories";

// Server actions are reachable by POST from anyone, whatever page renders
// them — the /admin layout's gate doesn't cover this, so check here too.
export async function unblockCategoryAction(formData: FormData): Promise<void> {
  const { userId } = await auth();
  if (!isAdmin(userId)) throw new Error("Admin only");

  const country = String(formData.get("country") ?? "").trim();
  const categoryCode = Number(formData.get("category_code"));
  if (!country || !Number.isInteger(categoryCode)) return;

  await unblockCategory(country, categoryCode);
  revalidatePath("/admin/blocked-categories");
}
