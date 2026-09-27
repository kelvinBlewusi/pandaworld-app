"use client";

/**
 * A video that behaves like a GIF: plays by itself, muted, on a loop, no
 * controls. Used for the WhatsApp flow on the homepage (requested
 * 2026-09-28: "make the video a gif so it autoplays").
 *
 * A real GIF of the 79-second recording would be tens of MB and blocky; a
 * H.264 loop is under 2 MB. It's only fetched once it's about to scroll
 * into view, and paused while off screen, so a visitor who never reaches
 * it on mobile data never downloads it. Visitors who ask for reduced
 * motion get the poster and a play button instead.
 *
 * Browsers only autoplay muted video, so the recording's sounds (message
 * whooshes, the "Live on Jumia" ding) sit behind a "Tap for sound" button.
 */

import { useEffect, useRef, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";

interface LoopingVideoProps {
  src:       string;
  poster:    string;
  width:     number;
  height:    number;
  label:     string;
  className?: string;
}

export function LoopingVideo({ src, poster, width, height, label, className = "" }: LoopingVideoProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    // Set as a property too: React doesn't reliably render the `muted`
    // attribute, and iOS only autoplays a video that's muted.
    video.muted = true;

    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      video.controls = true;
      video.preload = "none";
      video.src = src;
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          if (!video.getAttribute("src")) video.src = src;
          void video.play().catch(() => {});
        } else {
          video.pause();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, [src]);

  const toggleSound = () => {
    const video = ref.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
    // Unmuting is a tap, which also lets a video the browser held back start.
    if (!video.muted) {
      if (!video.getAttribute("src")) video.src = src;
      void video.play().catch(() => {});
    }
  };

  return (
    <div className="relative">
      <video
        ref={ref}
        poster={poster}
        width={width}
        height={height}
        muted
        loop
        playsInline
        preload="none"
        aria-label={label}
        className={className}
      />
      <button
        type="button"
        onClick={toggleSound}
        aria-pressed={!muted}
        aria-label={muted ? "Turn sound on" : "Turn sound off"}
        className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-full bg-black/65 px-3 py-1.5 text-sm font-medium text-white backdrop-blur-sm transition-colors hover:bg-black/80"
      >
        {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        {muted ? "Tap for sound" : "Sound on"}
      </button>
    </div>
  );
}
