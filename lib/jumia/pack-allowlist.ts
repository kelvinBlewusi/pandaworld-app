/**
 * Which orders may be packed from /admin/orders (app_settings key
 * orders_pack_allowed_numbers, a JSON array of order numbers). Packing assigns
 * a tracking number and commits a real customer's order to a shipping
 * provider, and Jumia's API has no undo for it, so it is OFF for every order
 * until the owner names it: the first was #388626919 (2026-10-06). Empty or
 * malformed means none, so a typo fails closed. Set by hand:
 *
 *   insert into app_settings (key, value) values ('orders_pack_allowed_numbers', '["388626919"]')
 *   on conflict (key) do update set value = excluded.value, updated_at = now();
 */

import { createServerClient } from "@/lib/supabase/server";

const KEY = "orders_pack_allowed_numbers";

export async function packAllowedNumbers(): Promise<string[]> {
  try {
    const { data, error } = await createServerClient().from("app_settings").select("value").eq("key", KEY).maybeSingle();
    if (error) throw new Error(error.message);
    const value = data?.value;
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is string => typeof v === "string" && /^\d{5,}$/.test(v));
  } catch (e) {
    console.warn(`[orders] couldn't read the pack allow-list, packing stays off: ${(e as Error).message}`);
    return [];
  }
}

export async function isPackAllowed(orderNumber: string): Promise<boolean> {
  return (await packAllowedNumbers()).includes(String(orderNumber));
}
