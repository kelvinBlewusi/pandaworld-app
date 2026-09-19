import { permanentRedirect } from "next/navigation";

// ─── /landing — retired ──────────────────────────────────────────────────────
//
// This used to render its own marketing copy (components/marketing/public-landing.tsx).
// The public site now has one homepage ("/", rendered by app/extension/page.tsx),
// so /landing 301s there instead of maintaining a second, drifting copy of the
// same pitch. Removed from app/sitemap.ts too.

export default function LandingPage() {
  permanentRedirect("/");
}
