/** The app's own public base URL, for links sent over WhatsApp (review
 *  pages, the Jumia connect link, etc.) — shared by draft.ts, batch.ts,
 *  and jumia-connect.ts rather than each re-deriving it. */
export function appUrl(): string {
  const url =
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://pandaworld.gh");
  return url.replace(/\/$/, "");
}
