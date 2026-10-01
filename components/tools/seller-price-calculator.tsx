import { PriceCalculator } from "@/components/tools/price-calculator";
import { CountryPriceCalculator } from "@/components/tools/country-price-calculator";
import { CalculatorCountrySwitch } from "@/components/tools/calculator-country-switch";
import { COUNTRY_FEES } from "@/lib/marketing/country-fees";
import type { JumiaCountry } from "@/lib/marketing/countries";

/**
 * The signed-in app's price calculator, for the seller's own Jumia
 * country (lib/marketing/visitor-country.ts): Ghana's full calculator, or
 * the per-country one from Jumia's 2026 tables. Ghana when the country is
 * unknown. The switch underneath stays on `basePath`, with ?country=.
 */
export function SellerPriceCalculator({ country, basePath }: { country: JumiaCountry | undefined; basePath: string }) {
  const code = country?.code ?? "GH";
  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-zinc-900">Price calculator</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Jumia {country?.name ?? "Ghana"}: calculate the price to show on Jumia or estimate the amount you will receive.
        </p>
      </div>
      {!country || country.code === "GH" ? (
        <PriceCalculator showHeader={false} />
      ) : (
        // Keyed so switching country starts afresh rather than keeping a
        // category picked from another country's list.
        <CountryPriceCalculator
          key={country.code}
          fees={COUNTRY_FEES[country.code]}
          currency={country.currency}
          wholeUnits={country.wholeUnits}
          samplePrice={country.samplePrice}
        />
      )}
      <CalculatorCountrySwitch current={code} hrefFor={(other) => `${basePath}?country=${other}`} />
    </div>
  );
}
