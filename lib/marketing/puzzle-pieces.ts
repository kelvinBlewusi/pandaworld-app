/**
 * Two interlocking jigsaw pieces, as SVG paths, for the "PandaWorld fits
 * Jumia" graphic (components/marketing/jumia-pandaworld-puzzle.tsx). Plain
 * geometry with no imports, so it can be previewed outside Next.
 *
 * The pieces share one seam: the left piece's right edge carries a tab, and
 * the right piece's left edge is the same points in reverse, so the tab
 * fits its socket exactly. Drawn with a white stroke, the seam shows as a
 * thin gap, as on a real puzzle. The outer edges bow a few pixels and the
 * corners differ a little, for a hand-cut look.
 */

export const PUZZLE_VIEWBOX = { width: 640, height: 300 } as const;

/** Where things sit, in viewBox units. */
export const PUZZLE_LAYOUT = {
  top:    28,
  bottom: 272,
  left:   18,
  seam:   322,
  right:  622,
  /** How far the tab reaches into the right piece. */
  tabReach: 67,
} as const;

type Point = [number, number];

const round = (n: number) => Math.round(n * 10) / 10;
const pt = ([x, y]: Point) => `${round(x)} ${round(y)}`;

/** A quadratic Bézier from a to b with control c, as points. */
function quad(a: Point, c: Point, b: Point, steps: number): Point[] {
  const out: Point[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    out.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]);
  }
  return out;
}

/**
 * The seam from top to bottom, as points: straight, then the tab (a neck
 * and a round bulb pointing right), then straight again.
 */
function seamPoints(): Point[] {
  const { top, bottom, seam } = PUZZLE_LAYOUT;
  const cy = (top + bottom) / 2;
  const neck = 17;      // half the neck's width
  const neckDepth = 12; // how far out the bulb starts
  const radius = 30;    // the bulb
  const shoulder = 13;  // the curve from the edge into the neck
  const bulbCentre = neckDepth + Math.sqrt(radius * radius - neck * neck);

  // u runs down the seam, v out to the right of it.
  const local: Point[] = [[top + 8, 0], [cy - neck - shoulder, 0]];
  local.push(...quad([cy - neck - shoulder, 0], [cy - neck, 0], [cy - neck, neckDepth], 6));
  // Round the bulb the long way, through its tip, from the top of the neck to the bottom.
  const start = Math.atan2(neckDepth - bulbCentre, -neck);       // about -124°
  const end = Math.atan2(neckDepth - bulbCentre, neck);          // about -56°
  const from = start < 0 ? start + 2 * Math.PI : start;          // about 236°
  const steps = 28;
  for (let i = 1; i <= steps; i++) {
    const a = from + ((end - from) * i) / steps;
    local.push([cy + radius * Math.cos(a), bulbCentre + radius * Math.sin(a)]);
  }
  local.push(...quad([cy + neck, neckDepth], [cy + neck, 0], [cy + neck + shoulder, 0], 6));
  local.push([bottom - 8, 0]);
  return local.map(([u, v]) => [seam + v, u]);
}

/** The left piece: the tab on its right edge. */
export function leftPiecePath(): string {
  const { top, bottom, left, seam } = PUZZLE_LAYOUT;
  const mid = (left + seam) / 2;
  const midY = (top + bottom) / 2;
  const tl = 34, bl = 40, s = 8;
  return [
    `M ${pt([left, top + tl])}`,
    `Q ${pt([left, top])} ${pt([left + tl, top])}`,
    `Q ${pt([mid, top - 5])} ${pt([seam - s, top])}`,
    `Q ${pt([seam, top])} ${pt([seam, top + s])}`,
    ...seamPoints().map((p) => `L ${pt(p)}`),
    `L ${pt([seam, bottom - s])}`,
    `Q ${pt([seam, bottom])} ${pt([seam - s, bottom])}`,
    `Q ${pt([mid, bottom + 4])} ${pt([left + bl, bottom])}`,
    `Q ${pt([left, bottom])} ${pt([left, bottom - bl])}`,
    `Q ${pt([left - 5, midY])} ${pt([left, top + tl])}`,
    "Z",
  ].join(" ");
}

/** The right piece: the same seam, reversed, as its socket. */
export function rightPiecePath(): string {
  const { top, bottom, seam, right } = PUZZLE_LAYOUT;
  const mid = (seam + right) / 2;
  const midY = (top + bottom) / 2;
  const tr = 38, br = 32, s = 8;
  return [
    `M ${pt([seam + s, top])}`,
    `Q ${pt([mid, top - 4])} ${pt([right - tr, top])}`,
    `Q ${pt([right, top])} ${pt([right, top + tr])}`,
    `Q ${pt([right + 5, midY])} ${pt([right, bottom - br])}`,
    `Q ${pt([right, bottom])} ${pt([right - br, bottom])}`,
    `Q ${pt([mid, bottom + 5])} ${pt([seam + s, bottom])}`,
    `Q ${pt([seam, bottom])} ${pt([seam, bottom - s])}`,
    ...seamPoints().reverse().map((p) => `L ${pt(p)}`),
    `L ${pt([seam, top + s])}`,
    `Q ${pt([seam, top])} ${pt([seam + s, top])}`,
    "Z",
  ].join(" ");
}
