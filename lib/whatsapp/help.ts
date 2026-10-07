/**
 * "help", for this seller's own pack (owner, 2026-10-07: "anyone types help
 * get a standard message or they get a tailored one for their current
 * package?" — tailored from now on). The commands every plan has, then what
 * their pack adds and what it doesn't have yet, then their credits.
 *
 * No astral-plane emoji in these lines: an array of strings with an
 * interpolation can be folded into one template literal by the minifier,
 * which once shipped "📦" as its escape sequence (lib/whatsapp/onboarding.ts).
 */

import { isUnmetered, availableCredits } from "@/lib/billing/extension-credits";
import { PACK_FEATURES, POLISH_CREDIT_COST, REPORT_CREDIT_COST, type PackFeature } from "@/lib/billing/credit-packs";
import { currentPack, featureAccess, type FeatureId } from "@/lib/billing/features";
import { isWebAddress } from "@/lib/whatsapp/channel";
import { createServerClient } from "@/lib/supabase/server";
import { sendButtonsIfConfigured } from "@/lib/whatsapp/client";

/** What each pack feature lets them do, in the help's words. */
const PACK_LINES: Partial<Record<FeatureId, string>> = {
  shop_changes:       "Change live products: e.g. *set the stock of the blue kettle to 10*, *put the iron on sale at 150 till Friday*, *turn off the fan*",
  qc_fix:             "Jumia QC rejections: I tell you why, return the credits and help you fix and resubmit",
  shipping_labels:    "Shipping label PDFs here on WhatsApp",
  order_alerts:       "Order alerts on WhatsApp: new orders and payouts",
  fee_calc_extension: "Jumia fee calculator on the Chrome extension panel",
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The help text for this seller (async: it reads their pack and credits). */
export async function helpFor(userId: string, phone: string): Promise<string> {
  const web = isWebAddress(phone);
  const unmetered = await isUnmetered(userId).catch(() => false);
  const pack = unmetered ? null : await currentPack(userId).catch(() => null);
  const where = unmetered ? "everything is on for you" : pack ? "on your " + cap(pack.id) + " pack" : "on your free credits";

  const lines: string[] = [
    "Here's what you can do, " + where + ".",
    "",
    "*List products*",
    "- Tell me how many (e.g. *3*), send each one's photos with the price and notes, then *done*.",
    "- *submit* sends the drafts to Jumia. *restart* starts over. *status* says where you are.",
    "",
    "*Your Jumia shop*" + (web ? " (type / or tap + for the list)" : " (type *menu* for the list)"),
    "- *orders*: pack, ready to ship or cancel",
    "- *sales today*, *sales week*, *shop*, *out of stock*, *payouts*",
    "- *polish 2*: 4 product photos from yours (" + POLISH_CREDIT_COST + " credits a photo)",
    "- *report*: a full health check of your shop (" + REPORT_CREDIT_COST + " credits)",
  ];

  if (!unmetered) {
    const extra = PACK_FEATURES.filter((f): f is PackFeature & { id: FeatureId } => f.id in PACK_LINES);
    const on: string[] = [];
    const off: string[] = [];
    for (const f of extra) {
      const access = await featureAccess(userId, f.id as FeatureId, { ignoreBalance: true }).catch(() => ({ ok: false as const }));
      if (f.comingSoon) continue;
      if (access.ok) on.push("- " + PACK_LINES[f.id as FeatureId]);
      else off.push("- " + f.short + ": " + cap(f.minPack) + " pack and up");
    }
    if (on.length > 0) lines.push("", "*On your pack*", ...on);
    if (off.length > 0) lines.push("", "*Bigger packs add*", ...off);
    const credits = Math.max(0, Math.round((await availableCredits(userId).catch(() => 0)) * 100) / 100);
    lines.push("", "Credits: " + credits + " available. *credits* for your balance and buying more.");
  }

  lines.push("", "*how it works* for the full guide." + (web ? " /clear starts this chat afresh." : ""));
  return lines.join("\n");
}

/** The help reply, with the buttons it has always had. */
export async function sendHelp(userId: string, phone: string): Promise<void> {
  await sendButtonsIfConfigured(phone, await helpFor(userId, phone), [
    { id: "status", title: "Status" },
    { id: "menu", title: "Menu" },
    { id: "restart", title: "Restart 🔄" },
  ]);
}

/**
 * Help sent without being asked, to sellers the owner names (owner,
 * 2026-10-07: "let's fire to the user a tailored Help message"): app_settings
 * `help_outbox` holds their user ids; the minute worker sends each one's
 * help to their linked WhatsApp number (or their web chat) and empties it.
 */
export async function sendQueuedHelp(): Promise<string[]> {
  const db = createServerClient();
  const { data } = await db.from("app_settings").select("value").eq("key", "help_outbox").maybeSingle();
  const queued = Array.isArray(data?.value) ? (data!.value as unknown[]).filter((v): v is string => typeof v === "string") : [];
  if (queued.length === 0) return [];
  // Emptied first: a send that fails isn't retried every minute.
  await db.from("app_settings").update({ value: [] }).eq("key", "help_outbox");
  const sent: string[] = [];
  for (const userId of queued.slice(0, 20)) {
    const { data: wa } = await db.from("whatsapp_connections").select("phone_number").eq("user_id", userId).limit(1);
    const number = ((wa ?? []) as { phone_number: string | null }[])[0]?.phone_number?.replace(/^\+/, "");
    const to = number || "web:" + userId;
    try {
      await sendHelp(userId, to);
      sent.push(userId);
    } catch (e) {
      console.warn("[help outbox] " + userId + ": " + (e as Error).message);
    }
  }
  return sent;
}
