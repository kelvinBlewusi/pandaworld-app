"use client";

import { useEffect } from "react";

/**
 * Tells the page framing this one (the extension panel) how tall the
 * calculator is, whenever that changes, so the frame fits it instead of
 * scrolling inside the panel's own scroll. Measures <main>, not the
 * document, which is never shorter than the frame and so could only grow.
 * Only a height: nothing private.
 */
export function ReportHeight() {
  useEffect(() => {
    const main = document.querySelector("main");
    if (window.parent === window || !main) return;
    const post = () => window.parent.postMessage({ type: "pandaworld:embed-height", height: Math.ceil(main.getBoundingClientRect().height) }, "*");
    const observer = new ResizeObserver(post);
    observer.observe(main);
    post();
    return () => observer.disconnect();
  }, []);
  return null;
}
