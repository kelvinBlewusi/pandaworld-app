/**
 * Where the public pages' nav and CTAs point. Sign-up and sign-in land on
 * the extension dashboard afterwards; the price calculators are public, so
 * logged-out visitors and search engines can use them.
 */

export const DASHBOARD_REDIRECT = "/extension/dashboard";
export const SIGN_IN_HREF = `/sign-in?redirect_url=${DASHBOARD_REDIRECT}`;
export const SIGN_UP_HREF = `/sign-up?redirect_url=${DASHBOARD_REDIRECT}`;
/** The nav and footer's calculator link: app/calculator redirects it to the
 *  visitor's own Jumia country's calculator (calculatorPathFor). */
export const CALCULATOR_HREF = "/calculator";
/** Ghana's calculator page, the one indexed as "Jumia price calculator". */
export const GHANA_CALCULATOR_HREF = "/jumia-price-calculator";
export const COMMISSION_RATES_HREF = "/jumia-commission-rates";
