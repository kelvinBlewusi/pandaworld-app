/**
 * The "Pandaworld" logo as SVG pieces: the gold-swoosh P
 * (public/brand/panda-p-logo.webp, a light copy of panda-p-logo-trimmed.png)
 * followed by "andaworld" in Inter Tight 800, laid out as the nav has it
 * (components/marketing/home-floating-nav.tsx: a 28px P, 21px text, -2px
 * overlap). For placing inside another SVG, which sets the font: the
 * Jumia × PandaWorld puzzle (components/marketing/jumia-pandaworld-puzzle.tsx).
 *
 * Units: the P is 100 tall. The text width is measured, not estimated:
 * "andaworld" at 100px with -2.5px letter-spacing is 479.06 wide in
 * Inter Tight 800, so 359.3 at 75px.
 */
const P_WIDTH = (100 * 634) / 562;
const TEXT_X = P_WIDTH - 7;
const TEXT_WIDTH = 359.3;

export const PANDAWORLD_LOGO = {
  width:  TEXT_X + TEXT_WIDTH,
  height: 100,
} as const;

/** The logo's pieces in its own units, for placing inside another SVG. */
export function PandaworldLogoMark({ ink = "#18181b" }: { ink?: string }) {
  return (
    <>
      <image href="/brand/panda-p-logo.webp" x={0} y={0} width={P_WIDTH} height={100} />
      <text x={TEXT_X} y={78} fontSize={75} fontWeight={800} letterSpacing={-1.875} fill={ink}>
        andaworld
      </text>
    </>
  );
}
