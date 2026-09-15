/**
 * Root 404. Catches any URL that doesn't match a route segment.
 *
 * Same visual language as app/error.tsx so a seller who mistypes a
 * URL doesn't bounce to Next.js's default. Two recovery actions:
 * dashboard for authenticated sellers, sign-in / landing for visitors.
 *
 * The dashboard link goes to APP_HOME, not /dashboard — see
 * lib/constants/routes.ts. A 404 cannot know whether the seller has
 * connected Jumia, and /dashboard bounces anyone who hasn't.
 */

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { APP_HOME } from "@/lib/constants/routes";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-6">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 text-3xl shadow-sm">
          🐼
        </div>
        <p className="text-xs font-semibold uppercase tracking-widest text-orange-500">
          404
        </p>
        <h1 className="mt-2 text-2xl font-bold text-zinc-900">
          We couldn&apos;t find that page.
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-zinc-600">
          The link might be old, mistyped, or the page may have moved. Pick a destination below to keep going.
        </p>

        <div className="mt-6 flex flex-col items-center gap-2 sm:flex-row sm:justify-center">
          <Button
            className="w-full bg-orange-500 hover:bg-orange-600 text-white sm:w-auto"
            asChild
          >
            <Link href={APP_HOME}>Open dashboard</Link>
          </Button>
          <Button variant="outline" className="w-full sm:w-auto" asChild>
            <Link href="/">Back to home</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
