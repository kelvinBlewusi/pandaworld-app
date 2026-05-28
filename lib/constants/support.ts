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

/**
 * Social channels for the brand. Used by the marketing footer and the
 * JSON-LD Organization `sameAs` array (which feeds Google's knowledge
 * panel + helps link our verified socials to the brand on search).
 *
 * URLs are canonicalised here (no tracking suffixes / referrer params)
 * so the same value is safe to use in both `<a href>` and structured
 * data. Add new channels by appending objects below — the footer maps
 * over this list.
 */
export const SOCIAL_LINKS = [
  {
    name:   "X (Twitter)",
    handle: "@pandaworldai",
    url:    "https://x.com/pandaworldai",
  },
  {
    name:   "Instagram",
    handle: "@pandaworldai",
    url:    "https://www.instagram.com/pandaworldai",
  },
] as const;
