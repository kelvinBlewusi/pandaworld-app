import { ACCENT, ACCENT_TEXT, LINE, TEXT } from "./palette";

/** Primary/secondary button — flat fill or outline, 6px radius, no shadow. */
export function MarketingButton({
  href,
  external,
  variant = "primary",
  children,
}: {
  href: string;
  external?: boolean;
  variant?: "primary" | "outline";
  children: React.ReactNode;
}) {
  const className =
    variant === "primary"
      ? "inline-flex items-center justify-center rounded-[6px] px-5 py-3 text-sm font-semibold transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      : "inline-flex items-center justify-center rounded-[6px] border px-5 py-3 text-sm font-semibold transition-colors hover:bg-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";
  const style =
    variant === "primary"
      ? { backgroundColor: ACCENT, color: ACCENT_TEXT, outlineColor: TEXT }
      : { borderColor: LINE, color: TEXT, outlineColor: TEXT };
  return (
    <a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
      className={className}
      style={style}
    >
      {children}
    </a>
  );
}
