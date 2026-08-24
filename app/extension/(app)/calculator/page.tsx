import { PriceCalculator } from "@/components/tools/price-calculator";

export const metadata: import("next").Metadata = {
  title: "Price Calculator — Extension",
  robots: { index: false },
};

export default function ExtensionCalculatorPage() {
  return <PriceCalculator />;
}
