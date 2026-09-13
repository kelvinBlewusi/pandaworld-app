/**
 * Donation amount bounds — plain constants, not "use server" (unlike
 * lib/billing/donations.ts) so the client-side DonateModal can import
 * them directly for input validation without pulling in Supabase.
 */
export const MIN_DONATION_GHS = 5;
export const MAX_DONATION_GHS = 10_000;
