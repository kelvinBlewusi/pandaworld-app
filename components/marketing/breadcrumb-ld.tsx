const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://pandaworldai.site";

/**
 * BreadcrumbList structured data, so Google can show "PandaWorld › Guides ›
 * …" under a result instead of the bare URL. `items` are [name, path]
 * pairs from the site root down to the current page.
 */
export function BreadcrumbLd({ items }: { items: [name: string, path: string][] }) {
  const ld = {
    "@context": "https://schema.org",
    "@type":    "BreadcrumbList",
    itemListElement: items.map(([name, path], i) => ({
      "@type":  "ListItem",
      position: i + 1,
      name,
      item:     `${APP_URL}${path}`,
    })),
  };
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />;
}
