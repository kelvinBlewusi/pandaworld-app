-- Adds read/dismiss tracking to the extension dashboard's notification bell
-- (components/extension/shell.tsx). Two independent additions:
--
-- extension_credits.notifications_seen_at — when this user last opened the
--   bell dropdown. A transaction newer than this is "new" (bold text + a
--   dot in the list, and lights up the bell's own alert dot); opening the
--   dropdown bumps this to now() via markNotificationsSeen() in
--   lib/billing/extension-credits.ts. NULL means "never opened it" — every
--   existing user's history will show as new the first time they open the
--   bell after this migration ships, since there's no way to know what
--   they'd already seen before this column existed.
--
-- extension_credit_transactions.dismissed_at — set when a user clicks the
--   "x" on one notification. The row itself is NEVER deleted — it's still
--   part of the credit ledger's audit trail and balance_after history.
--   Dismissal only hides it from getRecentTransactions()'s result going
--   forward.
--
-- Apply via Supabase Dashboard → SQL Editor → New query → paste → Run.
-- Idempotent — re-running is a no-op.

ALTER TABLE extension_credits
  ADD COLUMN IF NOT EXISTS notifications_seen_at timestamptz;

ALTER TABLE extension_credit_transactions
  ADD COLUMN IF NOT EXISTS dismissed_at timestamptz;

COMMENT ON COLUMN extension_credits.notifications_seen_at IS
  'Last time this user opened the notification bell dropdown — anything newer is shown as "new". Set by markNotificationsSeen() in lib/billing/extension-credits.ts.';

COMMENT ON COLUMN extension_credit_transactions.dismissed_at IS
  'Set when the user dismisses ("x") this notification from the bell dropdown. The row is kept for the credit ledger''s audit trail — getRecentTransactions() just filters it out once set.';
