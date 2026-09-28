/**
 * Can billing be switched on? The checks /admin/billing shows next to the
 * switch, and the gate the switch action applies before turning it on: a
 * seller who runs out of free credits must be able to buy more.
 *
 * Only ever reports whether a secret is set and which kind it is (live or
 * test, by its prefix), never the value.
 */

export type CheckStatus = "ok" | "warn" | "fail";

export interface ReadinessCheck {
  id:     string;
  label:  string;
  status: CheckStatus;
  detail: string;
}

export function appUrl(): string | null {
  return process.env.NEXT_PUBLIC_APP_URL?.trim() || null;
}

/**
 * Ask Paystack whether the secret key works, with an endpoint that
 * returns account settings rather than any customer's data.
 */
async function paystackKeyWorks(secretKey: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch("https://api.paystack.co/integration/payment_session_timeout", {
      headers: { Authorization: `Bearer ${secretKey}` },
      cache:   "no-store",
    });
    if (res.ok) return { ok: true, detail: "Paystack accepted the key." };
    return { ok: false, detail: `Paystack refused the key (HTTP ${res.status}).` };
  } catch (e) {
    return { ok: false, detail: `Couldn't reach Paystack: ${(e as Error).message}` };
  }
}

export async function billingReadiness(): Promise<ReadinessCheck[]> {
  const checks: ReadinessCheck[] = [];

  const secretKey = process.env.PAYSTACK_SECRET_KEY?.trim();
  if (!secretKey) {
    checks.push({ id: "paystack_key", label: "Paystack secret key", status: "fail", detail: "PAYSTACK_SECRET_KEY isn't set in Vercel, so nobody can buy credits." });
  } else {
    const live = secretKey.startsWith("sk_live_");
    const test = secretKey.startsWith("sk_test_");
    const works = await paystackKeyWorks(secretKey);
    checks.push({
      id:     "paystack_key",
      label:  "Paystack secret key",
      status: !works.ok ? "fail" : live ? "ok" : "warn",
      detail: `${live ? "Live key." : test ? "Test key: purchases won't take real money. Switch to the live key before billing real sellers." : "Set, but it doesn't look like a Paystack key (sk_live_… / sk_test_…)."} ${works.detail}`,
    });
  }

  const url = appUrl();
  checks.push(
    url
      ? { id: "app_url", label: "Site address", status: "ok", detail: `Paystack sends buyers back to ${url}/extension/dashboard.` }
      : { id: "app_url", label: "Site address", status: "fail", detail: "NEXT_PUBLIC_APP_URL isn't set, so Paystack would send buyers back to a temporary Vercel address." },
  );

  checks.push({
    id:     "webhook",
    label:  "Paystack webhook",
    status: "warn",
    detail: `Can't be checked from here. In Paystack → Settings → API Keys & Webhooks, the webhook URL must be ${url ?? "<your site>"}/api/paystack/webhook. It credits a purchase even if the buyer closes the tab before coming back.`,
  });

  return checks;
}

/** Billing may be switched on only when nothing is failing. */
export function readyToBill(checks: ReadinessCheck[]): boolean {
  return checks.every((c) => c.status !== "fail");
}
