import { ImageResponse } from "next/og";

// ─── Open Graph image — auto-generated at build time ─────────────────────────
//
// Next.js convention: `app/opengraph-image.tsx` renders this React
// component to a 1200x630 PNG that gets served at /opengraph-image.png
// and automatically referenced in the page's <meta og:image> tag.
//
// Flat palette, no gradients, matching the rest of the marketing site.
// Same image is reused as twitter-image via app/twitter-image.tsx.

export const runtime = "edge";

export const alt = "PandaWorld — Jumia listings from WhatsApp or Chrome";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const PAGE_BG = "#f6f3ee";
const TEXT = "#1c1917";
const MUTED = "#57534e";
const LINE = "#e7e5e4";
const ACCENT = "#c2410c";

// Panda-face mark — same shapes as components/marketing/wordmark.tsx's
// PandaMark, reproduced as raw JSX (Satori, next/og's renderer, doesn't run
// through a normal React tree so the component can't be imported directly).
function PandaMark({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 62 62">
      <circle cx="31" cy="34" r="26" fill="#ffffff" stroke={color} strokeWidth="5" />
      <circle cx="14" cy="14" r="9" fill={color} />
      <circle cx="48" cy="14" r="9" fill={color} />
      <ellipse cx="22" cy="32" rx="5" ry="7" fill={color} transform="rotate(-18 22 32)" />
      <ellipse cx="40" cy="32" rx="5" ry="7" fill={color} transform="rotate(18 40 32)" />
      <ellipse cx="31" cy="43" rx="3" ry="2" fill={color} />
    </svg>
  );
}

export default async function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "80px",
          backgroundColor: PAGE_BG,
          color: TEXT,
          fontFamily: "system-ui, sans-serif",
        }}
      >
        {/* Wordmark */}
        <div style={{ display: "flex", alignItems: "center", gap: "14px", fontSize: "36px", fontWeight: 700 }}>
          <PandaMark size={40} color={TEXT} />
          <span>PandaWorld</span>
        </div>

        {/* Headline */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginTop: "48px",
            fontSize: "62px",
            fontWeight: 700,
            lineHeight: 1.15,
            letterSpacing: "-0.02em",
            maxWidth: "980px",
          }}
        >
          <span>List on <span style={{ color: ACCENT }}>Jumia</span> from</span>
          <span>WhatsApp, or from Chrome.</span>
        </div>

        {/* Footer line */}
        <div
          style={{
            display: "flex",
            marginTop: "44px",
            paddingTop: "28px",
            borderTop: `1px solid ${LINE}`,
            fontSize: "24px",
            color: MUTED,
          }}
        >
          Free while we test.
        </div>
      </div>
    ),
    { ...size },
  );
}
