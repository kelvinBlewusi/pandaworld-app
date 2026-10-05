import { Inter_Tight } from "next/font/google";
import { leftPiecePath, rightPiecePath, PUZZLE_LAYOUT as L, PUZZLE_VIEWBOX as V } from "@/lib/marketing/puzzle-pieces";

const inter = Inter_Tight({ subsets: ["latin"], weight: ["800"], display: "swap" });

// Computed once: the pieces never change.
const LEFT = leftPiecePath();
const RIGHT = rightPiecePath();

const JUMIA_ORANGE = "#F68B1E";
const PANDA_INK = "#111111";

/**
 * Jumia and PandaWorld as two jigsaw pieces that lock together: Jumia's
 * orange with its name, PandaWorld's black with the panda and the
 * "pandaworld" name. Inline SVG, so it stays sharp at any size and needs no
 * image request. Jumia's name is plain text, not its logo.
 *
 * The panda is the one in the wordmark (components/marketing/wordmark.tsx),
 * with its ears outlined in white so they show on the black piece.
 */
export function JumiaPandaWorldPuzzle({ className = "" }: { className?: string }) {
  const cy = (L.top + L.bottom) / 2;
  const jumiaX = (L.left + L.seam) / 2;
  // The PandaWorld side's middle, between the socket's far end and the edge.
  const pandaX = (L.seam + L.tabReach + L.right) / 2;
  const pandaSize = 76;

  return (
    <svg
      viewBox={`0 0 ${V.width} ${V.height}`}
      role="img"
      aria-labelledby="jumia-pandaworld-title"
      className={`${inter.className} ${className}`}
    >
      <title id="jumia-pandaworld-title">PandaWorld fits into your Jumia shop</title>
      <path d={RIGHT} fill={PANDA_INK} stroke="#ffffff" strokeWidth={6} strokeLinejoin="round" />
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

      <g transform={`translate(${pandaX - pandaSize / 2} ${cy - 74}) scale(${pandaSize / 62})`}>
        <circle cx="31" cy="34" r="26" fill="#ffffff" stroke={PANDA_INK} strokeWidth={5} />
        <circle cx="14" cy="14" r="9" fill={PANDA_INK} stroke="#ffffff" strokeWidth={3} />
        <circle cx="48" cy="14" r="9" fill={PANDA_INK} stroke="#ffffff" strokeWidth={3} />
        <ellipse cx="22" cy="32" rx="5" ry="7" fill={PANDA_INK} transform="rotate(-18 22 32)" />
        <ellipse cx="40" cy="32" rx="5" ry="7" fill={PANDA_INK} transform="rotate(18 40 32)" />
        <ellipse cx="31" cy="43" rx="3" ry="2" fill={PANDA_INK} />
      </g>
      <text
        x={pandaX}
        y={cy + 58}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={34}
        fontWeight={800}
        letterSpacing={-1.4}
        fill="#ffffff"
      >
        pandaworld
      </text>
    </svg>
  );
}
