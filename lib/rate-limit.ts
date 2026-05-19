/**
 * In-memory rate limiter — sliding window per key.
 *
 * Why in-memory and not Upstash/Redis from day one:
 *   - Zero new infra to set up. Works on Vercel Hobby out of the box.
 *   - Free.
 *   - Covers ~95% of the abuse cases we care about (single seller
 *     hammering the same expensive endpoint from one browser).
 *
 * Limits of this implementation, in order of how much you should care:
 *   1. Per-function-instance state. Vercel runs multiple warm
 *      instances; a determined attacker could spread requests across
 *      them and bypass the limit. We accept this for now — the cost
 *      spike would show up in Vercel logs within the same hour, and
 *      we can swap to Upstash when we have real users.
 *   2. State is lost on cold start (every ~15 min of inactivity).
 *      Practically: limits reset when the function sleeps. Fine for
 *      hourly limits; bad for sub-minute limits.
 *   3. Memory leak via stale keys. Cleaned up lazily on each call —
 *      we drop timestamps older than the longest window we see.
 *
 * The function-call signature (rateLimit) and return shape match
 * @upstash/ratelimit's `.limit()` so swapping providers later is a
 * one-line change inside this module.
 */

interface RateLimitResult {
  /** True when the request is allowed. */
  success:   boolean;
  /** Remaining calls in the current window. 0 when blocked. */
  remaining: number;
  /** Unix ms when the limit resets (oldest timestamp + window). */
  resetAt:   number;
  /** Window length (ms) — propagated so handlers can set Retry-After. */
  windowMs:  number;
}

/**
 * Recorded timestamps per key. Sliding-window: we keep the last N
 * request timestamps; if N is at the limit AND the oldest is still
 * within the window, the next request is blocked.
 */
const buckets = new Map<string, number[]>();

/**
 * Sanity cap on bucket count to bound memory. If we somehow exceed
 * this (e.g. unique IPs from a scraper sweep), drop the oldest 25%
 * to release pressure. Picked so memory stays under ~1 MB even with
 * heavy fanout.
 */
const MAX_BUCKETS = 50_000;

export function rateLimit(
  key:      string,
  max:      number,
  windowMs: number,
): RateLimitResult {
  const now         = Date.now();
  const windowStart = now - windowMs;

  // Pull + filter to in-window timestamps.
  const all  = buckets.get(key) ?? [];
  const fresh = all.length === 0 ? [] : all.filter((t) => t >= windowStart);

  if (fresh.length >= max) {
    // Blocked. Don't add a new timestamp — that would extend the
    // window indefinitely. The oldest timestamp + windowMs is when
    // the seller can retry.
    buckets.set(key, fresh);
    return {
      success:   false,
      remaining: 0,
      resetAt:   (fresh[0] ?? now) + windowMs,
      windowMs,
    };
  }

  fresh.push(now);
  buckets.set(key, fresh);

  // Lazy cleanup so the map doesn't grow forever. Only checks when we
  // cross the cap — keeps the hot path fast. Use Array.from() because
  // tsconfig target is below ES2015 here and Map iterators aren't
  // directly iterable.
  if (buckets.size > MAX_BUCKETS) {
    const toDrop = Math.floor(MAX_BUCKETS * 0.25);
    const keys = Array.from(buckets.keys()).slice(0, toDrop);
    for (const k of keys) buckets.delete(k);
  }

  return {
    success:   true,
    remaining: Math.max(0, max - fresh.length),
    resetAt:   now + windowMs,
    windowMs,
  };
}

// ─── Per-route policies ──────────────────────────────────────────────────────
//
// Centralised here so it's one place to tune when we see real traffic.
// All limits are PER-USER (Clerk userId is the key). When the user is
// anonymous (cron, webhooks) the route bypasses the limit entirely;
// those have their own gates (CRON_SECRET, HMAC).

export const RATE_LIMITS = {
  // Most expensive — Gemini image-gen costs ~$0.039 × N images per call.
  // At 8 imgs × 10/hr = 80 enhances/hr = ~$3/hr/user worst case.
  enhanceImages:    { max: 10, windowMs: 60 * 60 * 1000 }, // 10/hour

  // Gemini text + vision passes. ~$0.02 per call. 30/hr = ~$0.60/hr/user.
  autoAnalyze:      { max: 30, windowMs: 60 * 60 * 1000 }, // 30/hour

  // Cheaper image polish (PhotoRoom). Still paid per image.
  polishImages:     { max: 50, windowMs: 60 * 60 * 1000 }, // 50/hour

  // Writes to Jumia VC. Reputational + duplicate-SKU risk. Tight cap.
  jumiaPush:        { max: 20, windowMs: 60 * 60 * 1000 }, // 20/hour
} as const;

// ─── Convenience wrapper ─────────────────────────────────────────────────────

/**
 * Apply a per-user rate limit. Returns either null (allowed) or a
 * pre-built NextResponse with status 429 + Retry-After header (block).
 *
 * Usage:
 *   const blocked = checkRateLimit(`enhance:${userId}`, RATE_LIMITS.enhanceImages);
 *   if (blocked) return blocked;
 */
import { NextResponse } from "next/server";

export function checkRateLimit(
  key:    string,
  policy: { max: number; windowMs: number },
): NextResponse | null {
  const result = rateLimit(key, policy.max, policy.windowMs);
  if (result.success) return null;

  const retryAfterSec = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
  const windowHuman = humanWindow(policy.windowMs);

  return NextResponse.json(
    {
      error: `Rate limit hit. You can make at most ${policy.max} requests per ${windowHuman}. Try again in ${humanDuration(retryAfterSec)}.`,
      retryAfter: retryAfterSec,
    },
    {
      status: 429,
      headers: {
        "Retry-After":             String(retryAfterSec),
        "X-RateLimit-Limit":       String(policy.max),
        "X-RateLimit-Remaining":   "0",
        "X-RateLimit-Reset":       String(Math.ceil(result.resetAt / 1000)),
      },
    },
  );
}

function humanWindow(windowMs: number): string {
  if (windowMs % (60 * 60 * 1000) === 0) {
    const h = windowMs / (60 * 60 * 1000);
    return h === 1 ? "hour" : `${h} hours`;
  }
  if (windowMs % (60 * 1000) === 0) {
    const m = windowMs / (60 * 1000);
    return m === 1 ? "minute" : `${m} minutes`;
  }
  return `${windowMs / 1000} seconds`;
}

function humanDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 60 * 60) return `${Math.ceil(seconds / 60)}m`;
  return `${Math.ceil(seconds / 60 / 60)}h`;
}
