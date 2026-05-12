"use client";

/**
 * Floating WhatsApp support button — draggable anywhere on the screen.
 * Saves its position to localStorage so it stays where the seller last
 * left it. A small drag threshold prevents accidental drags from
 * swallowing the link click.
 */

import { useEffect, useRef, useState } from "react";

const LS_KEY = "pw_wa_button_position";
const DRAG_THRESHOLD_PX = 5;  // movement before we consider it a drag (not a click)
const BUTTON_SIZE = 56;        // h-14 w-14

interface Position {
  // Bottom-right anchored — positive numbers mean further from the corner
  right:  number;
  bottom: number;
}

const DEFAULT_POSITION: Position = { right: 24, bottom: 24 };

function clamp(pos: Position): Position {
  if (typeof window === "undefined") return pos;
  const maxRight  = Math.max(0, window.innerWidth  - BUTTON_SIZE);
  const maxBottom = Math.max(0, window.innerHeight - BUTTON_SIZE);
  return {
    right:  Math.min(Math.max(0, pos.right),  maxRight),
    bottom: Math.min(Math.max(0, pos.bottom), maxBottom),
  };
}

export function WhatsAppButton() {
  const [position, setPosition] = useState<Position>(DEFAULT_POSITION);
  const [dragging, setDragging] = useState(false);
  const startRef = useRef<{ pointerX: number; pointerY: number; right: number; bottom: number } | null>(null);
  const movedRef = useRef(false);
  const buttonRef = useRef<HTMLAnchorElement | null>(null);

  // Load saved position
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Position;
        setPosition(clamp(parsed));
      }
    } catch { /* ignore */ }

    // Re-clamp on resize so the button never ends up off-screen
    const onResize = () => setPosition((p) => clamp(p));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Save when position changes (debounced)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const t = setTimeout(() => {
      try { window.localStorage.setItem(LS_KEY, JSON.stringify(position)); } catch { /* ignore */ }
    }, 200);
    return () => clearTimeout(t);
  }, [position]);

  const onPointerDown = (e: React.PointerEvent<HTMLAnchorElement>) => {
    if (e.button !== 0) return;            // left click only
    startRef.current = {
      pointerX: e.clientX,
      pointerY: e.clientY,
      right:    position.right,
      bottom:   position.bottom,
    };
    movedRef.current = false;
    buttonRef.current?.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLAnchorElement>) => {
    if (!startRef.current) return;
    const dx = e.clientX - startRef.current.pointerX;
    const dy = e.clientY - startRef.current.pointerY;
    if (!movedRef.current && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    movedRef.current = true;
    setDragging(true);
    // Right anchor decreases as user drags right; bottom anchor decreases as user drags down
    setPosition(
      clamp({
        right:  startRef.current.right  - dx,
        bottom: startRef.current.bottom - dy,
      })
    );
  };

  const onPointerUp = (e: React.PointerEvent<HTMLAnchorElement>) => {
    buttonRef.current?.releasePointerCapture(e.pointerId);
    startRef.current = null;
    // If user moved the button, suppress the link click that would otherwise fire
    if (movedRef.current) {
      e.preventDefault();
      setDragging(false);
    }
  };

  const onClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    // If the pointer-up handler already detected drag, ignore the click
    if (movedRef.current) e.preventDefault();
  };

  return (
    <a
      ref={buttonRef}
      href="https://wa.me/qr/CTHJ6NQ2QOOAO1"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Chat with support on WhatsApp (drag to reposition)"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onClick={onClick}
      style={{
        right:        position.right,
        bottom:       position.bottom,
        touchAction:  "none",
        cursor:       dragging ? "grabbing" : "grab",
      }}
      className="fixed z-50 flex h-14 w-14 items-center justify-center rounded-full bg-[#25D366] shadow-lg shadow-black/20 transition-shadow select-none active:scale-95 hover:scale-105"
    >
      <svg viewBox="0 0 32 32" className="h-7 w-7 fill-white pointer-events-none" xmlns="http://www.w3.org/2000/svg">
        <path d="M16.003 2C8.28 2 2 8.28 2 16.003c0 2.47.65 4.87 1.88 6.99L2 30l7.22-1.85A13.94 13.94 0 0 0 16.003 30C23.72 30 30 23.72 30 16.003 30 8.28 23.72 2 16.003 2zm0 25.47a11.52 11.52 0 0 1-5.88-1.61l-.42-.25-4.28 1.1 1.13-4.14-.27-.43A11.47 11.47 0 0 1 4.53 16c0-6.33 5.15-11.47 11.47-11.47S27.47 9.67 27.47 16 22.33 27.47 16.003 27.47zm6.3-8.6c-.35-.17-2.05-1.01-2.37-1.13-.31-.11-.54-.17-.77.17-.23.35-.88 1.13-1.08 1.36-.2.23-.4.25-.75.08-.35-.17-1.48-.55-2.82-1.74-1.04-.93-1.74-2.08-1.95-2.43-.2-.35-.02-.54.15-.71.16-.16.35-.4.52-.6.17-.2.23-.35.35-.58.11-.23.06-.44-.03-.61-.08-.17-.77-1.86-1.06-2.54-.28-.67-.56-.58-.77-.59h-.66c-.23 0-.6.08-.91.4-.31.31-1.19 1.16-1.19 2.83s1.22 3.28 1.39 3.51c.17.23 2.4 3.67 5.82 5.14.81.35 1.44.56 1.94.72.81.26 1.55.22 2.13.13.65-.1 2.01-.82 2.29-1.61.28-.8.28-1.48.2-1.62-.08-.14-.3-.22-.66-.39z"/>
      </svg>
    </a>
  );
}
