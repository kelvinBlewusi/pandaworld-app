/**
 * The Jumia markets, for the public /sell-on-jumia/<country> pages.
 *
 * Every fee fact here is taken from that country's official Jumia
 * VendorHub page (commissionsUrl / feesUrl), read 2026-09-28, and each
 * page links its source. Only what those pages state plainly is repeated.
 * The per-category rates and per-item fees are in
 * lib/marketing/country-fees.ts, copied from the same pages' 2026 tables.
 * Jumia changes fees, so re-check the sources before editing a number.
 */

import { GHANA_CALCULATOR_HREF } from "@/lib/marketing/links";

export type JumiaCountryCode = "GH" | "NG" | "KE" | "EG" | "MA" | "CI" | "SN" | "UG";

export interface JumiaCountry {
  /** URL segment: /sell-on-jumia/<slug>. Changing one breaks indexed links. */
  slug:         string;
  code:         JumiaCountryCode;
  name:         string;
  /** ISO 4217, for Intl currency formatting. */
  currency:     string;
  /** What sellers call the currency, for copy ("naira", "FCFA"). */
  currencyName: string;
  /** Whole units only (FCFA, shillings) or to two decimals. */
  wholeUnits:   boolean;
  storefront:   string;
  vendorCenter: string;
  vendorHub:    string;
  commissionsUrl: string;
  feesUrl?:     string;
  /** The language shoppers there mostly buy in. */
  marketLanguage: "English" | "French" | "Arabic";
  /** Statements from the country's VendorHub pages, in our words. */
  feeFacts:     string[];
  /** Jumia's own worked example from the same page, when it gives one. */
  example?:     string;
  /** A realistic amount for the calculator's placeholder. */
  samplePrice:  number;
}

export const JUMIA_COUNTRIES: JumiaCountry[] = [
  {
    slug: "ghana", code: "GH", name: "Ghana",
    currency: "GHS", currencyName: "cedis", wholeUnits: false,
    storefront: "jumia.com.gh", vendorCenter: "vendorcenter.jumia.com.gh",
    vendorHub: "https://vendorhub.jumia.com.gh/",
    commissionsUrl: "https://vendorhub.jumia.com.gh/commissions-2/",
    marketLanguage: "English",
    feeFacts: [
      "Commission is a percentage of the listing price that depends on the category, and it includes VAT.",
      "A shipping contribution is deducted per item, and it differs between Jumia Express and Drop Shipping.",
      "Jumia's pricing formula: listing price = (what you want to receive + shipping contribution) ÷ (1 − commission).",
    ],
    samplePrice: 950,
  },
  {
    slug: "nigeria", code: "NG", name: "Nigeria",
    currency: "NGN", currencyName: "naira", wholeUnits: true,
    storefront: "jumia.com.ng", vendorCenter: "vendorcenter.jumia.com.ng",
    vendorHub: "https://vendorhub.jumia.com.ng/",
    commissionsUrl: "https://vendorhub.jumia.com.ng/commissions-copy/",
    feesUrl: "https://vendorhub.jumia.com.ng/fees-copy/",
    marketLanguage: "English",
    feeFacts: [
      "Commission is a percentage of the price and depends on the product's category.",
      "Nigeria's 7.5% VAT is included in the commission fee.",
      "Jumia publishes the rate for every category path in its commission file on VendorHub Nigeria.",
    ],
    samplePrice: 25000,
  },
  {
    slug: "kenya", code: "KE", name: "Kenya",
    currency: "KES", currencyName: "shillings", wholeUnits: true,
    storefront: "jumia.co.ke", vendorCenter: "vendorcenter.jumia.co.ke",
    vendorHub: "https://vendorhub.jumia.co.ke/",
    commissionsUrl: "https://vendorhub.jumia.co.ke/commissions-copy/",
    marketLanguage: "English",
    feeFacts: [
      "Commission is a percentage of the price and depends on the product's category.",
      "Commission fees are inclusive of Kenya's 16% VAT.",
      "A shipping cost contribution is charged per order on top of the commission.",
    ],
    example: "Jumia Kenya's own example: a phone sold for KSh 16,000 at a 6% commission pays KSh 960 in commission plus a KSh 120 shipping contribution, KSh 1,080 in all.",
    samplePrice: 16000,
  },
  {
    slug: "egypt", code: "EG", name: "Egypt",
    currency: "EGP", currencyName: "Egyptian pounds", wholeUnits: false,
    storefront: "jumia.com.eg", vendorCenter: "vendorcenter.jumia.com.eg",
    vendorHub: "https://vendorhub.jumia.com.eg/",
    commissionsUrl: "https://vendorhub.jumia.com.eg/commissions-copy/",
    feesUrl: "https://vendorhub.jumia.com.eg/fees-copy-15-1-2026/",
    marketLanguage: "Arabic",
    feeFacts: [
      "Commission depends on the category and includes Egypt's 14% VAT.",
      "The current commissions and fees apply from 15 January 2026.",
      "Commission is charged once an order is delivered to the customer, and order preparation fees depend on the product's size.",
    ],
    samplePrice: 1000,
  },
  {
    slug: "morocco", code: "MA", name: "Morocco",
    currency: "MAD", currencyName: "dirhams", wholeUnits: false,
    storefront: "jumia.ma", vendorCenter: "vendorcenter.jumia.ma",
    vendorHub: "https://vendorhub.jumia.ma/",
    commissionsUrl: "https://vendorhub.jumia.ma/commissions-copy/",
    marketLanguage: "French",
    feeFacts: [
      "Commission depends on the category path and includes Morocco's 20% VAT.",
      "The current commissions apply from 15 January 2026.",
      "Commissions and order processing fees are only charged on delivered orders.",
    ],
    samplePrice: 300,
  },
  {
    slug: "cote-divoire", code: "CI", name: "Côte d'Ivoire",
    currency: "XOF", currencyName: "FCFA", wholeUnits: true,
    storefront: "jumia.ci", vendorCenter: "vendorcenter.jumia.ci",
    vendorHub: "https://vendorhub.jumia.ci/",
    commissionsUrl: "https://vendorhub.jumia.ci/commissions-2026/",
    marketLanguage: "French",
    feeFacts: [
      "Commission depends on the category and includes Côte d'Ivoire's 18% VAT.",
      "A fixed fee per item is added before the commission is applied.",
      "Jumia's pricing formula: Jumia price = (your price + fixed fee) ÷ (1 − commission).",
    ],
    example: "Jumia Côte d'Ivoire's own example, for a fashion item at 17% commission: (15,000 + 500 FCFA fixed fee) ÷ (1 − 0.17) = 18,675 FCFA.",
    samplePrice: 15000,
  },
  {
    slug: "senegal", code: "SN", name: "Senegal",
    currency: "XOF", currencyName: "FCFA", wholeUnits: true,
    storefront: "jumia.sn", vendorCenter: "vendorcenter.jumia.sn",
    vendorHub: "https://vendorhub.jumia.sn/",
    commissionsUrl: "https://vendorhub.jumia.sn/commissions-2026/",
    feesUrl: "https://vendorhub.jumia.sn/fees-copy/",
    marketLanguage: "French",
    feeFacts: [
      "Commission depends on the category, and the published percentages include VAT.",
      "The commission is the same whether your products are in your own warehouse or Jumia's.",
      "Shipping fees are listed separately on VendorHub Senegal's fees page.",
    ],
    samplePrice: 15000,
  },
  {
    slug: "uganda", code: "UG", name: "Uganda",
    currency: "UGX", currencyName: "shillings", wholeUnits: true,
    storefront: "jumia.ug", vendorCenter: "vendorcenter.jumia.co.ug",
    vendorHub: "https://vendorhub.jumia.ug/",
    commissionsUrl: "https://vendorhub.jumia.ug/commissions-copy/",
    feesUrl: "https://vendorhub.jumia.ug/fees-copy/",
    marketLanguage: "English",
    feeFacts: [
      "Registering as a seller is free, and there are no monthly fees.",
      "Jumia charges a commission and shipping fees on each successful sale.",
      "Commission rates and shipping fees are published on VendorHub Uganda.",
    ],
    samplePrice: 100000,
  },
];

export function getJumiaCountry(slug: string): JumiaCountry | undefined {
  return JUMIA_COUNTRIES.find((c) => c.slug === slug);
}

/** By ISO code ("NG", "ng"), as jumia_connections.country and Vercel's
 *  x-vercel-ip-country header give it. Undefined outside Jumia's markets. */
export function jumiaCountryByCode(code: string | null | undefined): JumiaCountry | undefined {
  const upper = code?.trim().toUpperCase();
  return upper ? JUMIA_COUNTRIES.find((c) => c.code === upper) : undefined;
}

/**
 * The calculator for a seller in `code`: Ghana's own calculator page, or
 * the calculator on that country's /sell-on-jumia page. Ghana is also the
 * answer when the country is unknown or Jumia doesn't sell there.
 */
export function calculatorPathFor(code: string | null | undefined): string {
  const country = jumiaCountryByCode(code);
  if (!country || country.code === "GH") return GHANA_CALCULATOR_HREF;
  return `/sell-on-jumia/${country.slug}#calculator`;
}
