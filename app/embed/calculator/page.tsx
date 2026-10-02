import type { Metadata } from "next";
import { PriceCalculator } from "@/components/tools/price-calculator";
import { CountryPriceCalculator } from "@/components/tools/country-price-calculator";
import { COUNTRY_FEES } from "@/lib/marketing/country-fees";
import { jumiaCountryByCode, type JumiaCountry } from "@/lib/marketing/countries";
import { ReportHeight } from "./report-height";

export const metadata: Metadata = {
  title: "Jumia price calculator",
  robots: { index: false, follow: false },
};

/**
 * One country's price calculator with nothing around it, for the Chrome
 * extension panel to show in a frame: the Pro and Business packs'
 * fee_calc_extension (lib/billing/credit-packs.ts). The panel passes the
 * seller's own country from GET /api/extension/account and offers no
 * switch, so a seller sees their country's fees only. Public, like the
 * site's own calculators; Ghana when the country isn't a Jumia one.
 */
export default function EmbeddedCalculatorPage({ searchParams }: { searchParams: { country?: string | string[] } }) {
  const code = typeof searchParams.country === "string" ? searchParams.country : null;
  const country = (jumiaCountryByCode(code) ?? jumiaCountryByCode("GH")) as JumiaCountry;
  return (
    <main className="bg-white px-3 py-3">
      {country.code === "GH" ? (
        <PriceCalculator showHeader={false} />
      ) : (
        <CountryPriceCalculator
          fees={COUNTRY_FEES[country.code]}
          currency={country.currency}
          wholeUnits={country.wholeUnits}
          samplePrice={country.samplePrice}
        />
      )}
      <ReportHeight />
    </main>
  );
}
