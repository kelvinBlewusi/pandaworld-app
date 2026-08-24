/**
 * "pandaworld" wordmark — lowercase Inter 800, with the `o` in
 * "pandaworld" replaced by a 62×62 panda-face SVG.
 *
 * Source: extracted from the wordmark design file at
 * Downloads/07 _ Wordmark_ panda _o_.html. We reproduce the SVG
 * shapes here directly (white head, two black ears, two angled black
 * eye-patches, small black nose) rather than embedding the 1.9 MB
 * HTML source — and we pull Inter from next/font/google so the
 * variable-weight typography ships at runtime, not in the bundle.
 *
 * Used in the marketing nav across /, /pricing, /terms, /privacy +
 * the footer. Sizes parametrically via the `size` prop — 28px is the
 * standard nav size, 64px is the landing hero size.
 */

import { Inter } from "next/font/google";

const inter = Inter({
  subsets: ["latin"],
  weight:  ["800"],
  display: "swap",
  variable: "--font-inter",
});

interface WordmarkProps {
  /** Height of the wordmark in px. Default 28 (matches nav). Hero uses 64. */
  size?: number;
  /** Override the text colour. Defaults to brand black #111. */
  color?: string;
  /**
   * Override the panda icon's ears/eyes/nose/outline colour. Defaults to
   * `color` (the historical behaviour). The icon's head is a HARDCODED
   * white fill, so on a dark page passing `color` alone as a light value
   * (e.g. cream, for the letters) makes the ears/eyes nearly invisible —
   * light-on-white. Pass a dark `iconColor` (e.g. near-black) separately
   * in that case so the face detail still contrasts against the white head.
   */
  iconColor?: string;
  /** Optional extra classes for layout (margin, alignment). */
  className?: string;
}

export function Wordmark({
  size      = 28,
  color     = "#111111",
  iconColor,
  className = "",
}: WordmarkProps) {
  // Letter font-size mirrors the SVG height so the panda-o sits at
  // the same x-height as the surrounding letters.
  const letterStyle = {
    fontSize:      `${size}px`,
    lineHeight:    `${size}px`,
    letterSpacing: `${size * -0.04}px`, // -2.5px at 64px scales proportionally
    color,
    fontWeight:    800,
    margin:        "0 -1px",
  } as const;

  return (
    <span
      className={`${inter.className} ${className} inline-flex items-center`}
      aria-label="pandaworld"
      style={{ height: size, lineHeight: 1 }}
    >
      <span style={letterStyle}>p</span>
      <span style={letterStyle}>a</span>
      <span style={letterStyle}>n</span>
      <span style={letterStyle}>d</span>
      <span style={letterStyle}>a</span>
      <span style={letterStyle}>w</span>
      <PandaO size={size} color={iconColor ?? color} />
      <span style={letterStyle}>r</span>
      <span style={letterStyle}>l</span>
      <span style={letterStyle}>d</span>
    </span>
  );
}

/**
 * The panda face used as the `o` in "pandaworld".
 *
 * White head with a 5px outline; two large black ears at the top
 * corners; two rotated black ellipse eye-patches; small dark nose
 * sat low in the face. Sized identically to the surrounding
 * uppercase x-height.
 */
function PandaO({ size, color }: { size: number; color: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 62 62"
      role="presentation"
      style={{ display: "inline-block", verticalAlign: "baseline", margin: `0 ${size * 0.02}px` }}
    >
      <circle cx="31" cy="34" r="26" fill="#ffffff" stroke={color} strokeWidth="5" />
      <circle cx="14" cy="14" r="9" fill={color} />
      <circle cx="48" cy="14" r="9" fill={color} />
      <ellipse cx="22" cy="32" rx="5" ry="7" fill={color} transform="rotate(-18 22 32)" />
      <ellipse cx="40" cy="32" rx="5" ry="7" fill={color} transform="rotate(18 40 32)" />
      <ellipse cx="31" cy="43" rx="3" ry="2" fill={color} />
    </svg>
  );
}
