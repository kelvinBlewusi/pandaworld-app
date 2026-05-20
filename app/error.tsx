"use client";

/**
 * Root error boundary. Catches any unhandled error that bubbles out of
 * a Server Component or a Client Component on a route segment under
 * the app root. Without this Next.js renders its unstyled default
 * error page — fine in dev, jarring next to our branded shell in prod.
 *
 * Stays minimal: brand chip, the apologetic copy, two recovery
 * actions, and a discreet error code at the bottom so a seller
 * sending us a support DM can quote it. The `digest` is set by
 * Next.js when the error came from a Server Component; it pairs with
 * the stack trace in Vercel logs.
 *
 * Note we DO NOT show the raw error.message — server errors can leak
 * internal state ("supabase rpc returned: …", "JWT decode failed at
 * line 47"). The seller gets a generic message; the underlying
 * details stay in our logs.
 */

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Best-effort telemetry. We don't have Sentry wired yet (next
  // phase), but Vercel surfaces server logs — push a tagged entry so
  // we can grep `[root-error]` to find production blow-ups quickly.
  useEffect(() => {
    console.error(`[root-error] ${error.message}`, error);
  }, [error]);

  return (
    <html lang="en">
      <body className="min-h-screen bg-zinc-50 antialiased">
        <main className="flex min-h-screen flex-col items-center justify-center px-6">
          <div className="w-full max-w-md text-center">
            <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 text-3xl shadow-sm">
              🐼
            </div>
            <h1 className="text-2xl font-bold text-zinc-900">
              Something went sideways.
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-zinc-600">
              That wasn&apos;t supposed to happen — we&apos;ve logged the issue and our team will look into it. Try again, or head back to the dashboard.
            </p>

            <div className="mt-6 flex flex-col items-center gap-2 sm:flex-row sm:justify-center">
              <Button
                onClick={reset}
                className="w-full bg-orange-500 hover:bg-orange-600 text-white sm:w-auto"
              >
                Try again
              </Button>
              <Button variant="outline" className="w-full sm:w-auto" asChild>
                <Link href="/dashboard">Back to dashboard</Link>
              </Button>
            </div>

            {error.digest && (
              <p className="mt-8 font-mono text-[11px] text-zinc-400">
                Error reference: {error.digest}
              </p>
            )}
          </div>
        </main>
      </body>
    </html>
  );
}
