import Link from "next/link";
import { JUMIA_COUNTRIES, calculatorPathFor, type JumiaCountryCode } from "@/lib/marketing/countries";

/**
 * "Selling in another country?" under a calculator, linking every other
 * Jumia country's calculator. The nav opens the visitor's own country
 * (app/calculator), and this is how they switch when that guess is wrong
 * or they sell in more than one. `hrefFor` lets the signed-in app keep the
 * switch inside its own page; the public pages use calculatorPathFor.
 */
export function CalculatorCountrySwitch({
  current,
  hrefFor = calculatorPathFor,
}: {
  current: JumiaCountryCode;
  hrefFor?: (code: JumiaCountryCode) => string;
}) {
  return (
    <p className="text-sm leading-relaxed text-zinc-500">
      Selling in another country?{" "}
      {JUMIA_COUNTRIES.filter((c) => c.code !== current).map((c, i) => (
        <span key={c.code}>
          {i > 0 && " · "}
          <Link href={hrefFor(c.code)} className="font-medium text-orange-600 hover:underline">{c.name}</Link>
        </span>
      ))}
    </p>
  );
}
