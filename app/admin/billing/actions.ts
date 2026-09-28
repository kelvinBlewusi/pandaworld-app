"use server";

import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/auth/is-admin";
import { setBillingEnabled } from "@/lib/billing/mode";
import { billingReadiness, readyToBill } from "@/lib/billing/readiness";
import { topUpBalancesTo } from "@/lib/billing/extension-credits";
import { FREE_SIGNUP_CREDITS } from "@/lib/billing/credit-packs";

// Server actions are reachable by POST from anyone, whatever page renders
// them — the /admin layout's gate doesn't cover this, so check here too.
async function requireAdmin(): Promise<string> {
  const { userId } = await auth();
  if (!userId || !isAdmin(userId)) throw new Error("Admin only");
  return userId;
}

export async function setBillingAction(formData: FormData): Promise<void> {
  const adminId = await requireAdmin();
  const turnOn = formData.get("billing") === "on";

  if (turnOn) {
    if (formData.get("confirm") !== "yes") redirect("/admin/billing?error=confirm");
    if (!readyToBill(await billingReadiness())) redirect("/admin/billing?error=not_ready");
  }

  await setBillingEnabled(turnOn, adminId);
  revalidatePath("/admin/billing");
  redirect(`/admin/billing?done=${turnOn ? "on" : "off"}`);
}

export async function topUpAction(): Promise<void> {
  await requireAdmin();
  const { toppedUp } = await topUpBalancesTo(FREE_SIGNUP_CREDITS);
  revalidatePath("/admin/billing");
  redirect(`/admin/billing?done=topup&count=${toppedUp}`);
}
