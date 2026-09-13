/**
 * Temporary growth-phase switch (2026-09-13). While `true`, every
 * signed-in user gets the exact same unmetered treatment ADMIN_USER_IDS
 * already got: unlimited extension/WhatsApp credits (lib/billing/
 * extension-credits.ts) AND unlimited plan quota (lib/billing/quota.ts,
 * which gates WhatsApp's createListingForUser too). This is a marketing
 * decision — get sellers using WhatsApp + the extension for free while
 * credit-based billing is finished and tested — not a removal of either
 * billing system. Neither the credit ledger nor the quota counters are
 * touched while this is on (deductCredits/incrementUsage both
 * short-circuit, same as they already do for admins), so flipping this
 * back to `false` and redeploying resumes real enforcement instantly,
 * with every user's real balance/usage exactly where it was.
 *
 * To switch back to paid billing: set this to `false` and redeploy.
 * Nothing else needs to change.
 */
export const FREE_FOR_ALL_MODE = true;
