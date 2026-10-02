"use client";

import { useEffect } from "react";

/**
 * Tells the page framing this one (the extension panel) how tall it is,
 * whenever that changes, so the frame fits the calculator instead of
 * scrolling inside the panel's own scroll. Only a height: nothing private.
 */
export function ReportHeight() {
  useEffect(() => {
    if (window.parent === window) return;
    const post = () => window.parent.postMessage({ type: "pandaworld:embed-height", height: document.documentElement.scrollHeight }, "*");
    const observer = new ResizeObserver(post);
    observer.observe(document.body);
    post();
    return () => observer.disconnect();
  }, []);
  return null;
}
