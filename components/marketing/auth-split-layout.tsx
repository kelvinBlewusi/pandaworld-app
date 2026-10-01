import Link from "next/link";
import Image from "next/image";
import { Wordmark } from "@/components/marketing/wordmark";

/**
 * Shared split-panel layout for /sign-in and /sign-up: a plain white form
 * column on the left, a full-bleed brand image on the right. Modelled on
 * a reference screenshot the seller sent (2026-09-24, a ListsGenie login
 * page) — logo + heading + form on one side, a warm full-height photo on
 * the other. We don't have lifestyle photography, so the right panel uses
 * one of PandaWorld's own panda-mascot illustrations instead of a stock
 * photo — same "give the page some warmth" job, on-brand rather than
 * generic.
 *
 * The image panel is dropped below `lg` — a login form is the one page a
 * visitor wants to get through fast on a phone, and a decorative image
 * pushing the form below the fold would work against that.
 */
export function AuthSplitLayout({
  title,
  subtitle,
  image,
  imageAlt,
  children,
}: {
  title:    string;
  subtitle: string;
  image:    string;
  imageAlt: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid min-h-screen bg-white lg:grid-cols-2">
      <div className="flex flex-col justify-center px-6 py-12 sm:px-12 lg:px-16 xl:px-24">
        <div className="mx-auto w-full max-w-sm">
          <Link href="/extension" aria-label="pandaworld home">
            <Wordmark size={24} />
          </Link>
          <h1 className="mt-10 text-3xl font-bold text-zinc-900">{title}</h1>
          <p className="mt-2 text-sm text-zinc-500">{subtitle}</p>
          <div className="mt-8">{children}</div>
          <p className="mt-6 text-xs text-zinc-500">
            By continuing you agree to our{" "}
            <Link href="/terms" className="underline hover:text-zinc-900">Terms</Link> and{" "}
            <Link href="/privacy" className="underline hover:text-zinc-900">Privacy Policy</Link>.
          </p>
        </div>
      </div>
      <div className="hidden bg-zinc-100 p-6 lg:block">
        <div className="relative h-full w-full overflow-hidden rounded-3xl">
          <Image
            src={image}
            alt={imageAlt}
            fill
            sizes="50vw"
            className="object-cover"
            priority
          />
        </div>
      </div>
    </div>
  );
}
