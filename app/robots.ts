import type { MetadataRoute } from "next";

// ─── robots.txt — Next.js convention file ────────────────────────────────────
//
// Next.js auto-renders this at /robots.txt at build time. Allows
// search engines to crawl public marketing pages while blocking the
// authenticated app (no benefit to indexing /dashboard or /settings,
// and we don't want Google attempting to crawl private listing data).
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
        disallow: [
          "/api/",            // server routes — never useful in search
          "/dashboard",       // authenticated dashboard
          "/listings",        // private listing data
          "/settings",        // private settings (account, billing)
          "/onboarding",      // signed-in onboarding flow
          "/admin",           // staff-only routes
          "/sign-in",         // Clerk-hosted; thin shell that redirects
          "/sign-up",         // same — let Google rank /pricing instead
        ],
      },
    ],
    sitemap:  `${APP_URL}/sitemap.xml`,
    host:     APP_URL,
  };
}
