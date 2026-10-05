import { Inter_Tight } from "next/font/google";
import { leftPiecePath, rightPiecePath, PUZZLE_LAYOUT as L, PUZZLE_VIEWBOX as V } from "@/lib/marketing/puzzle-pieces";
import { PandaworldLogoMark, PANDAWORLD_LOGO } from "@/components/marketing/pandaworld-logo";

const inter = Inter_Tight({ subsets: ["latin"], weight: ["800"], display: "swap" });

// Computed once: the pieces never change.
const LEFT = leftPiecePath();
const RIGHT = rightPiecePath();

const JUMIA_ORANGE = "#F68B1E";
// White, so the logo shows as it is (its P is black). The edge keeps the
// piece from melting into a light background.
const PANDAWORLD_PIECE = "#FFFFFF";
const PANDAWORLD_EDGE = "#D4D4D8";

/**
 * Jumia and PandaWorld as two jigsaw pieces that lock together: Jumia's
 * orange with its name, PandaWorld's white with the Pandaworld logo
 * (components/marketing/pandaworld-logo.tsx). Inline SVG, so it stays sharp
 * at any size; shown small in the marketing footer. Jumia's name is plain
 * text, not its logo.
 */
export function JumiaPandaWorldPuzzle({ className = "" }: { className?: string }) {
  const cy = (L.top + L.bottom) / 2;
  const jumiaX = (L.left + L.seam) / 2;
  // The PandaWorld side's middle, between the socket's far end and the edge.
  const logoX = (L.seam + L.tabReach + L.right) / 2;
  // As big as the piece allows: the footer shows the puzzle small.
  const logoWidth = 200;
  const scale = logoWidth / PANDAWORLD_LOGO.width;

  return (
    <svg
      viewBox={`0 0 ${V.width} ${V.height}`}
      role="img"
      aria-labelledby="jumia-pandaworld-title"
      className={`${inter.className} ${className}`}
    >
      <title id="jumia-pandaworld-title">PandaWorld fits into your Jumia shop</title>
      <path d={RIGHT} fill={PANDAWORLD_PIECE} stroke={PANDAWORLD_EDGE} strokeWidth={3} strokeLinejoin="round" />
      {/* Its white stroke is the seam between the two. */}
      <path d={LEFT} fill={JUMIA_ORANGE} stroke="#ffffff" strokeWidth={6} strokeLinejoin="round" />

      <text
        x={jumiaX}
        y={cy}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={58}
        fontWeight={800}
        letterSpacing={2}
        fill="#ffffff"
      >
        JUMIA
      </text>

      <g transform={`translate(${logoX - logoWidth / 2} ${cy - (PANDAWORLD_LOGO.height / 2) * scale}) scale(${scale})`}>
        <PandaworldLogoMark />
      </g>
    </svg>
  );
}
