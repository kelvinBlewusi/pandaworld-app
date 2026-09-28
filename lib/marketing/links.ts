/**
 * Where the public pages' nav and CTAs point. Sign-up and sign-in land on
 * the extension dashboard afterwards; the price calculator is public, so
 * logged-out visitors and search engines can use it.
 */

export const DASHBOARD_REDIRECT = "/extension/dashboard";
export const SIGN_IN_HREF = `/sign-in?redirect_url=${DASHBOARD_REDIRECT}`;
export const SIGN_UP_HREF = `/sign-up?redirect_url=${DASHBOARD_REDIRECT}`;
export const CALCULATOR_HREF = "/jumia-price-calculator";
export const COMMISSION_RATES_HREF = "/jumia-commission-rates";
