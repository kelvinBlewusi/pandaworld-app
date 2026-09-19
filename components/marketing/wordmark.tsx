/**
 * "PandaWorld" wordmark — normal case, no letter-tracking. A small panda
 * face mark sits in front of the text as a fixed icon (not substituted
 * into a letter), sized off `size` so it scales with the text height.
 *
 * Used in the marketing nav/footer/hero and /terms, /privacy. Callers
 * only ever pass `size`/`color`.
 */

interface WordmarkProps {
  /** Height of the wordmark in px. Default 28 (matches nav). */
  size?: number;
  /** Override the text colour. Defaults to brand ink #1c1917. */
  color?: string;
  /** Override the panda icon's ears/eyes/nose/outline colour. Defaults to `color`. */
  iconColor?: string;
  /** Optional extra classes for layout (margin, alignment). */
  className?: string;
}

export function Wordmark({
  size      = 28,
  color     = "#1c1917",
  iconColor,
  className = "",
}: WordmarkProps) {
  return (
    <span
      className={`${className} inline-flex items-center`}
      style={{ height: size, lineHeight: 1, gap: size * 0.22 }}
    >
      <PandaMark size={size * 0.86} color={iconColor ?? color} />
      <span
        style={{
          fontFamily: "system-ui, -apple-system, sans-serif",
          fontSize:   `${size * 0.62}px`,
          fontWeight: 700,
          color,
        }}
      >
        PandaWorld
      </span>
    </span>
  );
}

/** Small fixed panda-face mark used as the wordmark's icon. */
function PandaMark({ size, color }: { size: number; color: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 62 62"
      role="presentation"
      style={{ display: "inline-block", flexShrink: 0 }}
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
