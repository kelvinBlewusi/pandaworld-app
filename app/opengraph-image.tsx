import { ImageResponse } from "next/og";

// ─── Open Graph image — auto-generated at build time ─────────────────────────
//
// Next.js convention: `app/opengraph-image.tsx` renders this React
// component to a 1200x630 PNG that gets served at /opengraph-image.png
// and automatically referenced in the page's <meta og:image> tag.
//
// This means we get a branded link preview on WhatsApp / Twitter /
// LinkedIn / Facebook without anyone needing to design a static PNG.
// Edit the JSX below to update the preview; Vercel regenerates on
// every deploy.
//
// Same image is reused as twitter-image via app/twitter-image.tsx
// (which just re-exports this).
//
// 1200×630 is Facebook's recommended OG spec; Twitter accepts the
// same. Don't change the dimensions or social sites will crop badly.

export const runtime = "edge";

export const alt    = "PandaWorld — AI listings for Jumia Africa sellers";
export const size   = { width: 1200, height: 630 };
export const contentType = "image/png";

// Panda-face "o" mark — same shapes as components/marketing/wordmark.tsx's
// PandaO, reproduced as raw JSX (Satori, next/og's renderer, doesn't run
// through a normal React tree so the component can't be imported directly).
function PandaMark({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 62 62" style={{ margin: `0 ${size * 0.02}px` }}>
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
          height:        "100%",
          width:         "100%",
          display:       "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding:       "80px",
          backgroundColor: "#050505",
          backgroundImage:
            "radial-gradient(circle at 12% 8%, rgba(249,115,22,0.30) 0%, rgba(249,115,22,0) 45%), " +
            "radial-gradient(circle at 88% 92%, rgba(246,139,30,0.18) 0%, rgba(246,139,30,0) 45%)",
          color:         "#f4f1ea",
          fontFamily:    "Inter, sans-serif",
        }}
      >
        {/* Wordmark */}
        <div style={{ display: "flex", alignItems: "center", fontSize: "36px", fontWeight: 800, letterSpacing: "-1.4px" }}>
          <span>pandaw</span>
          <PandaMark size={36} color="#161616" />
          <span>rld</span>
        </div>

        {/* Headline */}
        <div
          style={{
            display:       "flex",
            flexDirection: "column",
            marginTop:     "44px",
            fontSize:      "74px",
            fontWeight:    700,
            lineHeight:    1.08,
            letterSpacing: "-0.02em",
            maxWidth:      "980px",
            color:         "#f7f4ee",
          }}
        >
          <span>Automate your</span>
          <div style={{ display: "flex", flexDirection: "row" }}>
            <span style={{ color: "#f68b1e", marginRight: "22px" }}>Jumia</span>
            <span>Listings with AI</span>
          </div>
        </div>

        {/* Chrome Extension badge */}
        <div
          style={{
            display:       "flex",
            alignItems:    "center",
            gap:           "12px",
            marginTop:     "40px",
            alignSelf:     "flex-start",
            border:        "1px solid rgba(255,255,255,0.3)",
            borderRadius:  "999px",
            padding:       "10px 22px",
            fontSize:      "20px",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color:         "rgba(239,236,230,0.9)",
          }}
        >
          <span style={{ width: "10px", height: "10px", borderRadius: "999px", background: "#f97316" }} />
          Chrome Extension
        </div>
      </div>
    ),
    { ...size },
  );
}
