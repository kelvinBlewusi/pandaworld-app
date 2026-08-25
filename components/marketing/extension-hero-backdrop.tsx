"use client";

/**
 * Dark, canvas-animated hero for /extension — the animated backdrop was
 * ported from a Claude Design export (`Hero Backdrop.dc.html`, project
 * 18cd00f4-19b6-4d97-99df-f824a1b8281e); the layout/copy/type treatment
 * around it has since diverged from that source per direct feedback —
 * centered content (was left-aligned), bold sans headline (was a serif
 * italic accent line), liquid-glass CTA pills, a shaded "card" Sign-in
 * link, no footer line.
 *
 * The canvas animation itself — a fan of drifting "ribbons" with a travelling
 * specular highlight, plus a subtle film-grain overlay — is a direct port of
 * the design's inline `Component.draw()` logic (originally written against
 * Claude Design's `DCLogic` runtime) into a plain React `useEffect` + canvas
 * 2D context. No dependency on that runtime; `support.js` (the file the
 * export imports) turned out to be that runtime's generic harness — not
 * needed here since we already have real React.
 *
 * Ribbon accent colour, and every orange highlight in the hero copy/CTAs,
 * uses PandaWorld's brand orange (#f97316 — Tailwind's orange-500, matching
 * every `bg-orange-500` elsewhere on the site) in place of the design's
 * generic peach (#ffb27a).
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Space_Grotesk } from "next/font/google";
import { ArrowRight } from "lucide-react";
import { Wordmark } from "@/components/marketing/wordmark";
import { BuyCreditsModal } from "@/components/extension/buy-credits-modal";

// Bold sans headline (700) unifies the type system with the nav/body, which
// are already Space Grotesk — no separate serif face needed.
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["300", "400", "500", "700"],
  display: "swap",
  variable: "--font-space-grotesk",
});

const ACCENT = "#f97316"; // Tailwind orange-500 — PandaWorld's brand orange
// Matches extension/panel/panel.css's --accent, which carries the same
// "Jumia orange" label — this file used to disagree with it (#F55203, a
// much redder shade). Used only on the word "Jumia"/"Vendor Center" so it
// reads as their brand, not ours.
const JUMIA_COLOR = "#f68b1e";

interface ExtensionHeroBackdropProps {
  signInHref: string;
  signUpHref: string;
  ctaHref: string;
  ctaLabel: string;
  // Whether the visitor already has a session — decides what the Pricing
  // popup's Buy button does (checkout vs. redirect to sign in).
  signedIn: boolean;
}

export function ExtensionHeroBackdrop({ signInHref, signUpHref, ctaHref, ctaLabel, signedIn }: ExtensionHeroBackdropProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // "Pricing" here opens the extension's own credit-pack pricing (the same
  // popup the dashboard uses) rather than navigating to /pricing, which is
  // the classic web app's monthly-plan pricing — a completely different
  // product from this visitor's point of view.
  const [pricingOpen, setPricingOpen] = useState(false);

  useEffect(() => {
    const cvs = canvasRef.current;
    const ctx = cvs?.getContext("2d");
    if (!cvs || !ctx) return;

    let dpr = 1;
    let w = 0;
    let h = 0;
    const resize = () => {
      const r = cvs.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = Math.max(1, r.width);
      h = Math.max(1, r.height);
      cvs.width = Math.round(w * dpr);
      cvs.height = Math.round(h * dpr);
    };
    resize();
    window.addEventListener("resize", resize);

    // Film-grain tile, blended with 'overlay' each frame for texture.
    const grain = (() => {
      const n = 128;
      const c = document.createElement("canvas");
      c.width = n;
      c.height = n;
      const g = c.getContext("2d");
      if (!g) return null;
      const img = g.createImageData(n, n);
      for (let i = 0; i < n * n; i++) {
        const v = 128 + (Math.random() - 0.5) * 255;
        img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
        img.data[i * 4 + 3] = 26;
      }
      g.putImageData(img, 0, 0);
      return ctx.createPattern(c, "repeat");
    })();

    // Cubic-bezier point between two normalized control-point sets, blended
    // by u (which ribbon, 0..1 across the fan) then evaluated at s (0..1
    // along the curve).
    function bez(A: number[][], B: number[][], u: number, s: number): [number, number] {
      const p: [number, number][] = [0, 1, 2, 3].map((k) => [
        A[k][0] + (B[k][0] - A[k][0]) * u,
        A[k][1] + (B[k][1] - A[k][1]) * u,
      ]);
      const m = 1 - s;
      const a = m * m * m;
      const b = 3 * m * m * s;
      const c = 3 * m * s * s;
      const d = s * s * s;
      return [
        a * p[0][0] + b * p[1][0] + c * p[2][0] + d * p[3][0],
        a * p[0][1] + b * p[1][1] + c * p[2][1] + d * p[3][1],
      ];
    }

    const A: number[][] = [[-0.10, -0.10], [0.34, 0.02], [0.44, 0.40], [0.20, 1.10]];
    const B: number[][] = [[0.52, -0.10], [1.16, 0.16], [1.34, 0.74], [0.98, 1.14]];
    const SEG = 84;
    const N = 24; // ribbon count
    const ax = parseInt(ACCENT.slice(1, 3), 16);
    const ay = parseInt(ACCENT.slice(3, 5), 16);
    const az = parseInt(ACCENT.slice(5, 7), 16);

    function draw(ms: number) {
      const W = w;
      const H = h;
      const t = ms * 0.001;

      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.fillStyle = "#050505";
      ctx!.fillRect(0, 0, W, H);
      ctx!.lineCap = "round";

      for (let i = 0; i < N; i++) {
        const u0 = i / (N - 1);
        const u = u0 + 0.010 * Math.sin(t * 0.28 + i * 0.62) + 0.006 * Math.sin(t * 0.11 + i * 0.19);
        const dotted = i % 5 === 3;
        const warm = i % 7 === 2;
        const body = 4 + 46 * Math.pow(u0, 1.25);

        // Travelling highlight centre — offset per ribbon so light sweeps
        // across the fan rather than pulsing in place.
        const phase = (t * 0.085 + i * 0.055) % 1;
        const sc = phase * 1.5 - 0.25;
        const spread = 0.10 + 0.09 * Math.sin(t * 0.2 + i);
        const sc2 = ((t * 0.052 + i * 0.031 + 0.5) % 1) * 1.5 - 0.25;

        const pts: [number, number][] = [];
        for (let k = 0; k <= SEG; k++) {
          const s = k / SEG;
          const p = bez(A, B, u, s);
          pts.push([p[0] * W, p[1] * H]);
        }

        // Faint blade body — every ribbon, always visible.
        ctx!.beginPath();
        ctx!.moveTo(pts[0][0], pts[0][1]);
        for (let k = 1; k <= SEG; k++) ctx!.lineTo(pts[k][0], pts[k][1]);
        ctx!.lineWidth = body;
        ctx!.strokeStyle = "rgba(255,255,255,0.022)";
        ctx!.stroke();
        ctx!.lineWidth = Math.max(1, body * 0.24);
        ctx!.strokeStyle = "rgba(255,255,255,0.03)";
        ctx!.stroke();

        if (dotted) {
          for (let k = 0; k <= SEG; k += 2) {
            const s = k / SEG;
            const g = Math.exp(-Math.pow((s - sc) / spread, 2) * 3.2);
            const g2 = 0.45 * Math.exp(-Math.pow((s - sc2) / (spread * 1.4), 2) * 3.2);
            const a = 0.05 + 0.95 * Math.min(1, g + g2);
            if (a < 0.06) continue;
            ctx!.beginPath();
            ctx!.arc(pts[k][0], pts[k][1], 0.8 + 0.9 * a, 0, Math.PI * 2);
            ctx!.fillStyle = `rgba(255,255,255,${(a * 0.85).toFixed(3)})`;
            ctx!.fill();
            if (a > 0.5) {
              ctx!.beginPath();
              ctx!.arc(pts[k][0], pts[k][1], 3.4, 0, Math.PI * 2);
              ctx!.fillStyle = `rgba(255,255,255,${(a * 0.09).toFixed(3)})`;
              ctx!.fill();
            }
          }
          continue;
        }

        // Specular rim — the moving highlight sweep, warm-tinted on every 7th ribbon.
        for (let k = 0; k < SEG; k++) {
          const s = (k + 0.5) / SEG;
          const g = Math.exp(-Math.pow((s - sc) / spread, 2) * 3.0);
          const g2 = 0.4 * Math.exp(-Math.pow((s - sc2) / (spread * 1.5), 2) * 3.0);
          const a = Math.min(1, 0.035 + 1.15 * (g + g2));
          if (a < 0.05) continue;
          const col = warm && a > 0.3 ? `rgba(${ax},${ay},${az},` : "rgba(255,255,255,";
          if (a > 0.18) {
            ctx!.beginPath();
            ctx!.moveTo(pts[k][0], pts[k][1]);
            ctx!.lineTo(pts[k + 1][0], pts[k + 1][1]);
            ctx!.lineWidth = 6 + 16 * a;
            ctx!.strokeStyle = col + (a * 0.07).toFixed(3) + ")";
            ctx!.stroke();
          }
          ctx!.beginPath();
          ctx!.moveTo(pts[k][0], pts[k][1]);
          ctx!.lineTo(pts[k + 1][0], pts[k + 1][1]);
          ctx!.lineWidth = 0.9 + 1.9 * a;
          ctx!.strokeStyle = col + a.toFixed(3) + ")";
          ctx!.stroke();
        }
      }

      if (grain) {
        ctx!.save();
        ctx!.globalCompositeOperation = "overlay";
        ctx!.fillStyle = grain;
        ctx!.translate(((t * 13) % 128) - 128, ((t * 7) % 128) - 128);
        ctx!.fillRect(0, 0, W + 256, H + 256);
        ctx!.restore();
      }
    }

    let raf = 0;
    const t0 = performance.now();
    const loop = (now: number) => {
      draw(now - t0);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <>
    <section
      className={`${spaceGrotesk.variable} relative min-h-screen w-full overflow-hidden bg-[#050505]`}
      style={{ fontFamily: "var(--font-space-grotesk), system-ui, sans-serif", color: "#efece6" }}
    >
      <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" />
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 90% at 18% 78%, rgba(255,255,255,0.05) 0%, rgba(0,0,0,0) 55%), " +
            "radial-gradient(100% 100% at 50% 50%, rgba(0,0,0,0) 40%, rgba(0,0,0,0.55) 100%)",
        }}
      />

      {/* px-5 on phones (was px-7): with the nav's own width, 28px gutters
          left the header wider than a 375px viewport, and the resulting
          horizontal overflow is what made the centred hero text below read
          as pushed off to one side. */}
      <div className="relative z-10 box-border grid min-h-screen grid-rows-[auto_1fr] px-5 pb-16 pt-10 sm:px-12 lg:px-24">
        <header className="flex flex-wrap items-center justify-between gap-4 sm:gap-8">
          <Link href="/extension" aria-label="pandaworld home">
            {/* iconColor dark — the icon's head is a hardcoded white fill, so
                the ears/eyes/nose need a DARK colour to read against it. The
                letters stay light cream via `color` to read against the
                page's near-black background. */}
            <Wordmark size={26} color="#f4f1ea" iconColor="#161616" />
          </Link>
          <nav className="flex items-center gap-2 text-[12px] uppercase tracking-[0.08em] sm:gap-3 sm:text-[13px]">
            <button
              type="button"
              onClick={() => setPricingOpen(true)}
              className="px-1.5 transition-colors hover:!text-white sm:px-2"
              style={{ color: "rgba(239,236,230,0.78)" }}
            >
              Pricing
            </button>
            {/* "Card" treatment — shaded pill background, distinguishing it
                as a button rather than a plain nav link. */}
            <Link
              href={signInHref}
              className="whitespace-nowrap rounded-full px-3 py-2 transition-colors hover:!bg-white/[0.1] sm:px-4"
              style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "rgba(239,236,230,0.85)" }}
            >
              Sign in
            </Link>
            {/* Liquid-glass pill — frosted translucent layer with an inner
                highlight/shadow for depth, echoing Apple's "Liquid Glass"
                material rather than a flat fill. */}
            <Link
              href={signUpHref}
              className="whitespace-nowrap rounded-full px-3 py-2 font-medium normal-case tracking-normal text-white backdrop-blur-xl transition-transform hover:scale-[1.03] sm:px-4"
              style={{
                background: "linear-gradient(135deg, rgba(255,255,255,0.28), rgba(255,255,255,0.08))",
                border: "1px solid rgba(255,255,255,0.35)",
                boxShadow:
                  "inset 0 1px 1px rgba(255,255,255,0.5), inset 0 -1px 2px rgba(0,0,0,0.15), 0 8px 20px rgba(0,0,0,0.25)",
              }}
            >
              Get Started
            </Link>
          </nav>
        </header>

        <div className="flex items-center justify-center text-center">
          <div className="flex max-w-[760px] flex-col items-center">
            <div
              className="inline-flex items-center gap-2.5 rounded-full border px-3.5 py-[7px] text-[12px] uppercase tracking-[0.1em] backdrop-blur-[6px]"
              style={{ borderColor: "rgba(255,255,255,0.2)", color: "rgba(239,236,230,0.85)" }}
            >
              <span
                className="h-[5px] w-[5px] rounded-full"
                style={{ background: ACCENT, boxShadow: `0 0 10px 2px ${ACCENT}99` }}
              />
              Chrome Extension · Beta
            </div>
            {/* Bold sans headline (Space Grotesk 700) instead of the design's
                serif italic — reads cleaner/punchier for a product headline,
                and unifies the type system with the nav/body, which are
                already Space Grotesk. */}
            <h1
              className="mt-6 font-bold"
              style={{
                fontFamily: "var(--font-space-grotesk), system-ui, sans-serif",
                // 32px floor (was 38px): at 38px the headline wrapped to four
                // cramped lines inside a phone's content width. Desktop is
                // unchanged — 6vw still caps at 72px well before then.
                fontSize: "clamp(32px, 6vw, 72px)",
                lineHeight: 1.08,
                letterSpacing: "-0.02em",
                color: "#f7f4ee",
              }}
            >
              Automate your <span style={{ color: JUMIA_COLOR }}>Jumia</span> Listings with AI
            </h1>
            <p
              className="mt-6 max-w-[520px] text-[17px] font-light leading-relaxed"
              style={{ color: "rgba(239,236,230,0.88)" }}
            >
              Do your listing on{" "}
              <span style={{ color: JUMIA_COLOR, fontWeight: 500 }}>Vendor Center</span> like
              always but this time automatically. Upload a photo, pick a category, and
              PandaWorld&apos;s AI fills the whole form for you. SEO-optimised. You review
              and submit.
            </p>
            {/* Stacked full-width on phones, inline row from sm up: three
                pills wrapping at phone width left a ragged 2-then-1 layout
                with the odd one out floating centred under the pair. */}
            <div className="mt-9 flex w-full flex-col items-stretch gap-3 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center sm:justify-center sm:gap-3.5">
              <Link
                href={ctaHref}
                className="inline-flex items-center justify-center gap-2 rounded-full px-6 py-3.5 text-sm font-medium text-white backdrop-blur-xl transition-transform hover:scale-[1.02]"
                style={{
                  background: "linear-gradient(135deg, rgba(255,255,255,0.28), rgba(255,255,255,0.08))",
                  border: "1px solid rgba(255,255,255,0.35)",
                  boxShadow:
                    "inset 0 1px 1px rgba(255,255,255,0.5), inset 0 -1px 2px rgba(0,0,0,0.15), 0 8px 20px rgba(0,0,0,0.25)",
                }}
              >
                {ctaLabel}
                <ArrowRight className="h-4 w-4" />
              </Link>
              <a
                href="#how-it-works"
                className="inline-flex items-center justify-center gap-2 rounded-full border px-6 py-3.5 text-sm transition-colors hover:!border-white/45 hover:!text-white"
                style={{ borderColor: "rgba(255,255,255,0.18)", color: "rgba(239,236,230,0.85)" }}
              >
                See how it works
              </a>
              <Link
                href={ctaHref}
                className="inline-flex items-center justify-center gap-2 rounded-full border px-6 py-3.5 text-sm transition-colors hover:!border-white/45 hover:!text-white"
                style={{ borderColor: "rgba(255,255,255,0.18)", color: "rgba(239,236,230,0.85)" }}
              >
                Try for free
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
    <BuyCreditsModal
      open={pricingOpen}
      onClose={() => setPricingOpen(false)}
      signedIn={signedIn}
      signInHref={signInHref}
    />
    </>
  );
}
