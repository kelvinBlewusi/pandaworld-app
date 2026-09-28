import { Lock } from "lucide-react";

/**
 * Vendor Center's Generate Token button, drawn inline in instructions: an
 * orange padlock, matching what sellers see in the Actions column of
 * Settings → Applications.
 */
export function PadlockIcon() {
  return (
    <Lock
      aria-label="padlock icon"
      className="mx-0.5 inline h-4 w-4 -translate-y-px align-middle text-orange-500"
      strokeWidth={2.5}
    />
  );
}
