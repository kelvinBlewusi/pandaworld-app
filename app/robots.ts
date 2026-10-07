import type { MetadataRoute } from "next";

// ─── robots.txt — Next.js convention file ────────────────────────────────────
//
// Next.js auto-renders this at /robots.txt at build time.
//
// The sitemap line points crawlers at app/sitemap.ts, which lists
// every public route worth indexing.

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://pandaworldai.site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow:     "/",
        // Only the API is closed to crawlers. Every other private page is
        // closed by itself: a signed-out request gets a 404 (Clerk), and
        // sign-in, sign-up, onboarding and the embed carry noindex. A page
        // blocked here can't be read, so Google never sees its noindex or
        // 404 and keeps the bare URL ("Indexed, though blocked by
        // robots.txt", Search Console, 2026-10-07).
        disallow: ["/api/"],
      },
    ],
    sitemap:  `${APP_URL}/sitemap.xml`,
    host:     APP_URL,
  };
}
