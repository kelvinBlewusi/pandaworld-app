/**
 * Messages WhatsApp accepted but couldn't deliver.
 *
 * The send API answers 200 for a message it will fail to deliver later,
 * and the failure arrives on the webhook as a status update. The commonest
 * cause is 131047: a free-form message outside the 24-hour customer
 * service window, which needs a template instead. QC and rejection alerts
 * can land days after a seller's last message, so these are recorded in
 * app_errors (source "whatsapp-delivery") rather than lost.
 */

import { createServerClient } from "@/lib/supabase/server";

export interface FailedDelivery {
  wamid:     string;
  recipient: string;
  code:      number | null;
  title:     string;
  details:   string | null;
}

interface StatusError { code?: number; title?: string; message?: string; error_data?: { details?: string } }
interface StatusUpdate { id?: string; status?: string; recipient_id?: string; errors?: StatusError[] }

/** The failed status updates in a webhook payload. */
export function failedDeliveries(body: unknown): FailedDelivery[] {
  const out: FailedDelivery[] = [];
  for (const entry of (body as { entry?: unknown[] })?.entry ?? []) {
    for (const change of (entry as { changes?: unknown[] })?.changes ?? []) {
      const statuses = ((change as { value?: { statuses?: StatusUpdate[] } })?.value?.statuses) ?? [];
      for (const s of statuses) {
        if (s.status !== "failed") continue;
        const err = s.errors?.[0];
        out.push({
          wamid:     s.id ?? "",
          recipient: s.recipient_id ?? "",
          code:      err?.code ?? null,
          title:     err?.title ?? err?.message ?? "unknown error",
          details:   err?.error_data?.details ?? null,
        });
      }
    }
  }
  return out;
}

/** Record failed deliveries. Awaited: a status-only webhook call returns right after. */
export async function recordFailedDeliveries(failures: FailedDelivery[]): Promise<void> {
  if (failures.length === 0) return;
  for (const f of failures) {
    console.warn(`[whatsapp delivery] ${f.wamid} to ${f.recipient} failed: ${f.code} ${f.title}`);
  }
  try {
    const { error } = await createServerClient().from("app_errors").insert(
      failures.map((f) => ({
        source:  "whatsapp-delivery",
        message: `${f.code ?? "?"} ${f.title}${f.code === 131047 ? " (outside the 24-hour window: needs a template)" : ""}`,
        stack:   null,
        context: { wamid: f.wamid, phoneNumber: f.recipient, details: f.details },
      })),
    );
    if (error) console.warn(`[whatsapp delivery] couldn't record failures: ${error.message}`);
  } catch (e) {
    console.warn(`[whatsapp delivery] couldn't record failures: ${(e as Error).message}`);
  }
}
