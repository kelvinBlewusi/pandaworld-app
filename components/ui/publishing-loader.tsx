"use client";

import { useEffect, useRef } from "react";

// ─── PublishingLoader ────────────────────────────────────────────────────────
//
// Full-viewport overlay that takes over the screen while a listing is being
// pushed to Jumia. Renders public/loader/jumia-publishing.html in an
// iframe so the animated SVG globe (built with d3 + topojson + world-atlas)
// matches the designer's HTML byte-for-byte, with zero risk of a React
// port regressing the visuals or bloating the bundle with d3.
//
// Caption updates: the parent can swap the caption mid-flight by passing
// new `caption`/`subCaption` props — the component postMessages the
// iframe, which patches its text nodes. Used to transition from
// "Sending…" → "Almost there…" while the artificial settle delay runs
// (Jumia's /feeds/{id} endpoint needs a few seconds after a successful
// push before it reports anything useful).

interface PublishingLoaderProps {
  /** Optional main caption — defaults to the one baked into the HTML. */
  caption?:    string;
  /** Optional secondary caption under the main one. */
  subCaption?: string;
}

export function PublishingLoader({ caption, subCaption }: PublishingLoaderProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Send caption updates whenever the props change. We resend on load too
  // because the iframe may not have its message handler attached yet when
  // we first mount.
  useEffect(() => {
    const send = () => {
      const win = iframeRef.current?.contentWindow;
      if (!win) return;
      win.postMessage(
        { type: "caption", main: caption, sub: subCaption },
        "*",
      );
    };
    send();
    const t = setTimeout(send, 250); // catch the iframe-just-mounted case
    return () => clearTimeout(t);
  }, [caption, subCaption]);

  return (
    <div
      role="alert"
      aria-live="polite"
      aria-busy="true"
      className="fixed inset-0 z-[999] bg-[#f4f1ea]"
    >
      <iframe
        ref={iframeRef}
        src="/loader/jumia-publishing.html"
        className="block h-full w-full border-0"
        title="Publishing to Jumia"
        // Allow scripts (needed for d3 + the animation) but no top-nav.
        sandbox="allow-scripts allow-same-origin"
      />
    </div>
  );
}
