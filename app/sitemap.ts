import type { MetadataRoute } from "next";
import { GUIDES } from "@/lib/marketing/guides";
import { JUMIA_COUNTRIES } from "@/lib/marketing/countries";
import { COMMISSION_RATES_HREF, GHANA_CALCULATOR_HREF } from "@/lib/marketing/links";

// ─── sitemap.xml — Next.js convention file ───────────────────────────────────
//
// Next.js auto-renders this at /sitemap.xml at build time. Lists every
// PUBLIC route worth indexing so Google can crawl them in a single
// pass instead of discovering them link-by-link.
//
// Private routes (/dashboard, /listings, /settings, /onboarding) are
// intentionally excluded — they're behind Clerk auth and would 401 for
// the crawler.
//
// Priority + changeFrequency are hints, not hard rules. Google takes
// them as a suggestion of relative importance + crawl cadence.

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://pandaworldai.site";

export default function sitemap(): MetadataRoute.Sitemap {
  // One last-modified timestamp for all marketing routes; bump on
  // significant copy / pricing changes so Google re-crawls.
  const lastModified = new Date();

  return [
    {
      url:            APP_URL,
      lastModified,
      changeFrequency: "weekly",
      priority:        1.0,                   // landing — highest
    },
    {
      url:            `${APP_URL}/landing`,
      lastModified,
      changeFrequency: "weekly",
      priority:        0.9,
    },
    {
      url:            `${APP_URL}/pricing`,
      lastModified,
      changeFrequency: "monthly",
      priority:        0.9,                   // pricing page — high
    },
    {
      url:            `${APP_URL}/how-to`,
      lastModified,
      changeFrequency: "monthly",
      priority:        0.8,                   // setup guides — targets "how to" searches
    },
    // One page per guide (app/how-to/[slug]), each aimed at its own search.
    ...GUIDES.map((g) => ({
      url:             `${APP_URL}/how-to/${g.slug}`,
      lastModified,
      changeFrequency: "monthly" as const,
      priority:        0.7,
    })),
    {
      url:            `${APP_URL}${GHANA_CALCULATOR_HREF}`,
      lastModified,
      changeFrequency: "monthly",
      priority:        0.8,                   // free tool — "Jumia price calculator"
    },
    {
      url:            `${APP_URL}${COMMISSION_RATES_HREF}`,
      lastModified,
      changeFrequency: "monthly",
      priority:        0.8,                   // "Jumia commission rates Ghana"
    },
    {
      url:            `${APP_URL}/sell-on-jumia`,
      lastModified,
      changeFrequency: "monthly",
      priority:        0.8,
    },
    // One page per Jumia market (app/sell-on-jumia/[country]).
    ...JUMIA_COUNTRIES.map((c) => ({
      url:             `${APP_URL}/sell-on-jumia/${c.slug}`,
      lastModified,
      changeFrequency: "monthly" as const,
      priority:        0.8,
    })),
    {
      url:            `${APP_URL}/terms`,
      lastModified,
      changeFrequency: "yearly",
      priority:        0.3,                   // legal — low
    },
    {
      url:            `${APP_URL}/privacy`,
      lastModified,
      changeFrequency: "yearly",
      priority:        0.3,
    },
  ];
}
