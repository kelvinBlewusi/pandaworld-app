/**
 * Single source of truth for support / community contact details.
 *
 * Anywhere in the app that needs the support email or the community
 * WhatsApp invite should import from here. If we move to a different
 * email host, or rotate the WhatsApp invite, it's a one-line change
 * (no codebase-wide grep + replace).
 */

export const SUPPORT_EMAIL = "help.pandaworldai@gmail.com";

/** `mailto:` ready-to-use href. */
export const SUPPORT_MAILTO = `mailto:${SUPPORT_EMAIL}`;

/**
 * Community WhatsApp group invite. The `?mode=gi_t` suffix is what
 * makes the link open the group-invite UI on mobile WhatsApp
 * (gi_t = "group invite, tracked"); don't strip it.
 */
export const COMMUNITY_WHATSAPP_URL =
  "https://chat.whatsapp.com/HINMw1QxsQFHbetQLv2Q4h?mode=gi_t";
