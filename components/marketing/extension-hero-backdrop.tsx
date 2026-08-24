"use client";

/**
 * Dark, canvas-animated hero for /extension — ported from a Claude Design
 * export (`Hero Backdrop.dc.html`, project 18cd00f4-19b6-4d97-99df-f824a1b8281e).
 *
 * The design file's placeholder copy ("datafall", "Streaming engine v4",
 * "Every signal, in motion.") is swapped for PandaWorld's real extension copy;
 * the visual system (full-bleed animated canvas, radial vignette, serif
 * italic headline accent, pill nav/CTA, minimal footer line) is kept as-is.
 *
 * The canvas animation itself — a fan of drifting "ribbons" with a travelling
 * specular highlight, plus a subtle film-grain overlay — is a direct port of
 * the design's inline `Component.draw()` logic (originally written against
 * Claude Design's `DCLogic` runtime) into a plain React `useEffect` + canvas
 * 2D context. No dependency on that runtime; `support.js` (the file the
 * export imports) turned out to be that runtime's generic harness — not
 * needed here since we already have real React.
 *
 * Ribbon accent colour uses PandaWorld's brand orange (#f97316 — Tailwind's
 * orange-500, matching every `bg-orange-500` elsewhere on the site) in place
 * of the design's generic peach (#ffb27a).
 */

import { useEffect, useRef } from "react";
import Link from "next/link";
import { Instrument_Serif, Space_Grotesk } from "next/font/google";
import { ArrowRight } from "lucide-react";
import { Wordmark } from "@/components/marketing/wordmark";

const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: ["400"],
  style: ["normal", "italic"],
  display: "swap",
  variable: "--font-instrument-serif",
});
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["300", "400", "500"],
  display: "swap",
  variable: "--font-space-grotesk",
});

const ACCENT = "#f97316"; // Tailwind orange-500 — PandaWorld's brand orange

interface ExtensionHeroBackdropProps {
  signInHref: string;
  ctaHref: string;
  ctaLabel: string;
}

export function ExtensionHeroBackdrop({ signInHref, ctaHref, ctaLabel }: ExtensionHeroBackdropProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

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
    <section
      className={`${instrumentSerif.variable} ${spaceGrotesk.variable} relative min-h-screen w-full overflow-hidden bg-[#050505]`}
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

      <div className="relative z-10 box-border grid min-h-screen grid-rows-[auto_1fr_auto] px-7 pb-11 pt-10 sm:px-12 lg:px-24">
        <header className="flex items-center justify-between gap-8">
          <Link href="/extension" aria-label="pandaworld home">
            <Wordmark size={26} color="#f4f1ea" />
          </Link>
          <nav
            className="flex items-center gap-6 text-[13px] uppercase tracking-[0.08em]"
            style={{ color: "rgba(239,236,230,0.6)" }}
          >
            <Link href="/pricing" className="transition-colors hover:!text-white" style={{ color: "inherit" }}>
              Pricing
            </Link>
            <Link href={signInHref} className="transition-colors hover:!text-white" style={{ color: "inherit" }}>
              Sign in
            </Link>
          </nav>
        </header>

        <div className="flex items-center">
          <div className="max-w-[720px]">
            <div
              className="inline-flex items-center gap-2.5 rounded-full border px-3.5 py-[7px] text-[12px] uppercase tracking-[0.1em] backdrop-blur-[6px]"
              style={{ borderColor: "rgba(255,255,255,0.14)", color: "rgba(239,236,230,0.72)" }}
            >
              <span
                className="h-[5px] w-[5px] rounded-full"
                style={{ background: ACCENT, boxShadow: `0 0 10px 2px ${ACCENT}99` }}
              />
              Chrome Extension · Beta
            </div>
            <h1
              className="mt-6 font-normal"
              style={{
                fontFamily: "var(--font-instrument-serif), serif",
                fontSize: "clamp(44px, 6.8vw, 96px)",
                lineHeight: 1.0,
                letterSpacing: "-0.02em",
                color: "#f7f4ee",
              }}
            >
              Fill Jumia listings
              <br />
              <em style={{ fontStyle: "italic", color: "#cfc7b8" }}>without leaving Jumia.</em>
            </h1>
            <p
              className="mt-6 max-w-[480px] text-[17px] font-light leading-relaxed"
              style={{ color: "rgba(239,236,230,0.62)" }}
            >
              Do your listing on Vendor Center like always. Upload a photo, pick a
              category, and PandaWorld&apos;s AI fills the whole form — SEO-optimised
              and built to pass QC. You review and submit.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-3.5">
              <Link
                href={ctaHref}
                className="inline-flex items-center gap-2 rounded-full px-6 py-3.5 text-sm transition-colors hover:!bg-white"
                style={{ background: "#f4f1ea", color: "#0a0a0a" }}
              >
                {ctaLabel}
                <ArrowRight className="h-4 w-4" />
              </Link>
              <a
                href="#how-it-works"
                className="inline-flex items-center gap-2 rounded-full border px-6 py-3.5 text-sm transition-colors hover:!border-white/45 hover:!text-white"
                style={{ borderColor: "rgba(255,255,255,0.18)", color: "rgba(239,236,230,0.85)" }}
              >
                See how it works
              </a>
            </div>
          </div>
        </div>

        <footer
          className="flex items-end justify-between gap-8 text-[12px] uppercase tracking-[0.09em]"
          style={{ color: "rgba(239,236,230,0.38)" }}
        >
          <span>Scroll</span>
          <span>Works alongside your PandaWorld plan</span>
        </footer>
      </div>
    </section>
  );
}
