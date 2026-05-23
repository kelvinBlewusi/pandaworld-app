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

export const alt    = "PandaWorld — AI listings for Jumia Ghana sellers";
export const size   = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          height:        "100%",
          width:         "100%",
          display:       "flex",
          flexDirection: "column",
          alignItems:    "flex-start",
          justifyContent: "center",
          padding:       "80px",
          background:    "linear-gradient(135deg, #fff7ed 0%, #ffffff 60%, #faf5ff 100%)",
          color:         "#18181b",
          fontFamily:    "Inter, sans-serif",
        }}
      >
        {/* Top-left brand chip */}
        <div
          style={{
            display:        "flex",
            alignItems:     "center",
            gap:            "12px",
            padding:        "8px 14px",
            background:     "#fff7ed",
            border:         "1px solid #fed7aa",
            borderRadius:   "999px",
            fontSize:       "20px",
            color:          "#c2410c",
            fontWeight:     500,
          }}
        >
          <span style={{ fontSize: "24px" }}>🐼</span>
          Built for Jumia Ghana sellers
        </div>

        {/* Main headline */}
        <div
          style={{
            display:    "flex",
            flexDirection: "column",
            marginTop:  "40px",
            fontSize:   "72px",
            fontWeight: 700,
            lineHeight: 1.05,
            letterSpacing: "-0.02em",
            maxWidth:   "900px",
          }}
        >
          <span>List your products</span>
          <span>
            to Jumia with{" "}
            <span
              style={{
                background:           "linear-gradient(135deg, #f97316, #9333ea)",
                backgroundClip:       "text",
                color:                "transparent",
              }}
            >
              one click.
            </span>
          </span>
        </div>

        {/* Subhead */}
        <div
          style={{
            marginTop:  "32px",
            fontSize:   "28px",
            color:      "#52525b",
            maxWidth:   "900px",
            lineHeight: 1.4,
          }}
        >
          AI generates the listing, picks the right Jumia category,
          fills attributes, and pushes straight to Vendor Center.
        </div>

        {/* Bottom-left price strip */}
        <div
          style={{
            position:   "absolute",
            bottom:     "60px",
            left:       "80px",
            display:    "flex",
            alignItems: "center",
            gap:        "24px",
            fontSize:   "22px",
            color:      "#71717a",
          }}
        >
          <span style={{ fontWeight: 600, color: "#18181b" }}>
            pandaworldai.site
          </span>
          <span>·</span>
          <span>5 free listings every month</span>
        </div>

        {/* Bottom-right pricing chip */}
        <div
          style={{
            position:     "absolute",
            bottom:       "60px",
            right:        "80px",
            display:      "flex",
            alignItems:   "center",
            padding:      "12px 22px",
            background:   "#18181b",
            color:        "#fff",
            borderRadius: "999px",
            fontSize:     "22px",
            fontWeight:   600,
          }}
        >
          From GHS 30 / month
        </div>
      </div>
    ),
    { ...size },
  );
}
