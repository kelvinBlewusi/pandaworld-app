import { auth } from "@clerk/nextjs/server";
import { SellerPriceCalculator } from "@/components/tools/seller-price-calculator";
import { jumiaCountryByCode } from "@/lib/marketing/countries";
import { visitorJumiaCountry } from "@/lib/marketing/visitor-country";

export const metadata: import("next").Metadata = {
  title: "Price Calculator — Extension",
  robots: { index: false },
};

// The seller's own Jumia country, unless they switched with ?country=.
export default async function ExtensionCalculatorPage({ searchParams }: { searchParams: { country?: string | string[] } }) {
  const { userId } = await auth();
  const picked = typeof searchParams.country === "string" ? jumiaCountryByCode(searchParams.country) : undefined;
  const country = picked ?? await visitorJumiaCountry(userId);
  return <SellerPriceCalculator country={country} basePath="/extension/calculator" />;
}
