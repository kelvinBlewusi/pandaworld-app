import Link from "next/link";
import { MarketingFooter } from "@/components/marketing/footer";
import { Wordmark } from "@/components/marketing/wordmark";

// ─── Public Privacy Policy ───────────────────────────────────────────────────
//
// Published 2026-10-01 as written, without a lawyer's review (owner's
// decision); a Ghana-qualified lawyer's review is still advisable.
// Aligned with:
//   - Ghana Data Protection Act, 2012 (Act 843)
//   - GDPR principles (since we serve customers via international
//     processors like Clerk, Supabase, Google)
//   - Each third-party processor we actually send data to today:
//       Clerk (auth)
//       Supabase (database + storage)
//       Google (Gemini AI)
//       PhotoRoom (image processing)
//       Paystack (payments)
//       Jumia (marketplace)
//       Vercel (hosting)
//
// Lists every category of data we collect, the legal basis, retention,
// the seller's rights, and the contact path for data-subject requests.

export const metadata: import("next").Metadata = {
  title:       "Privacy Policy",
  description: "How PandaWorld collects, uses, stores and shares your data. Compliant with the Ghana Data Protection Act 2012 (Act 843). Details on Clerk, Supabase, Google Gemini, PhotoRoom, Paystack, Vercel processors.",
  alternates: {
    canonical: "/privacy",
  },
  robots: {
    index:  true,
    follow: true,
  },
};

const LAST_UPDATED = "2026-05-20";
const COMPANY_NAME = "PandaWorld";

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-white text-zinc-900">
      <SimpleNav active="privacy" />

      <main className="mx-auto max-w-3xl px-6 py-16">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-orange-500">
            Legal
          </p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
            Privacy Policy
          </h1>
          <p className="mt-3 text-sm text-zinc-500">
            Last updated: {LAST_UPDATED}
          </p>
        </div>

        <div className="prose prose-sm prose-zinc mt-10 max-w-none">
          <p>
            This Privacy Policy explains how {COMPANY_NAME} (&quot;we&quot;,
            &quot;us&quot;) collects, uses, stores and shares your personal
            data when you use our service. We comply with the Ghana Data
            Protection Act, 2012 (Act 843).
          </p>

          <h2>1. Data we collect</h2>
          <p>
            We collect the following categories of personal data:
          </p>
          <ul>
            <li>
              <strong>Account data</strong>: email address, name,
              authentication identifiers — collected through Clerk
              when you sign up or sign in.
            </li>
            <li>
              <strong>Jumia connection data</strong>: your Jumia
              Vendor Center store name, seller ID, shop ID, app ID,
              app secret, OAuth access and refresh tokens, and
              country. Sensitive credentials (tokens and app secret)
              are encrypted at rest using AES-256-GCM.
            </li>
            <li>
              <strong>Product data</strong>: images, titles,
              descriptions, prices, categories, attributes, and
              variant details you create or upload to PandaWorld.
            </li>
            <li>
              <strong>Payment data</strong>: subscription status,
              billing period, transaction references. The card or
              mobile-money details themselves are collected and stored
              by Paystack — we never see or store them.
            </li>
            <li>
              <strong>Usage data</strong>: server logs (API requests,
              error traces, performance metrics) collected by Vercel
              for service operation and abuse prevention.
            </li>
            <li>
              <strong>Chrome extension data</strong>: when you click
              Autofill in the PandaWorldAI browser extension, it reads
              the product form on the Jumia Vendor Center page you are
              viewing and sends us the product photo on that page, the
              names of the form fields shown, any text those fields
              already contain, and the notes you type into the
              extension panel. This is used only to generate the
              listing content for that one request. The extension runs
              only on <code>vendorcenter.jumia.com</code>, never reads
              any other website, and stores nothing on your device
              except your PandaWorld API key.
            </li>
          </ul>

          <h2>2. Why we collect it (legal basis)</h2>
          <ul>
            <li>
              <strong>Contract performance</strong>: We process your
              data to deliver the Service you signed up for — running
              AI analysis, polishing images, pushing listings to
              Jumia, billing your subscription.
            </li>
            <li>
              <strong>Legitimate interests</strong>: keeping the
              Service secure (logging, abuse prevention, rate
              limiting), improving model output quality, supporting
              you when something goes wrong.
            </li>
            <li>
              <strong>Legal obligation</strong>: keeping payment
              records for tax and accounting purposes.
            </li>
            <li>
              <strong>Consent</strong>: when you connect Jumia via
              OAuth you consent to us holding your access and refresh
              tokens. You can revoke this any time via Settings →
              Integrations → Disconnect.
            </li>
          </ul>

          <h2>3. Third parties we share data with</h2>
          <p>
            We rely on third-party processors to operate the Service.
            We only share the minimum data each one needs:
          </p>
          <ul>
            <li>
              <strong>Clerk</strong> (clerk.com) — identity and
              authentication. Stores your email, name, sign-in
              method.
            </li>
            <li>
              <strong>Supabase</strong> (supabase.com) — database,
              file storage, and authentication backing store. Stores
              your listings, encrypted Jumia tokens, and product
              images.
            </li>
            <li>
              <strong>Google (Gemini API)</strong> — AI provider for
              text generation, image analysis, and image generation.
              Product images and prompts you submit are sent to
              Google for processing — including the product photo,
              form-field names and notes the browser extension sends
              when you click Autofill. Per Google&apos;s API terms,
              your data is NOT used to train Google&apos;s models.
            </li>
            <li>
              <strong>PhotoRoom</strong> (photoroom.com) — image
              polish (background removal, white background, drop
              shadow). Receives the product images you choose to
              polish.
            </li>
            <li>
              <strong>Paystack</strong> (paystack.com) — payment
              processor. Receives your card or mobile-money details
              directly; we receive only the transaction reference and
              status.
            </li>
            <li>
              <strong>Jumia Vendor Center</strong> (jumia.com) —
              receives the listings you push, plus your OAuth-
              authorised actions on your store.
            </li>
            <li>
              <strong>Vercel</strong> (vercel.com) — hosting and edge
              compute provider. Sees all incoming requests and server
              logs.
            </li>
          </ul>
          <p>
            We do <strong>not</strong> sell your data, share it with
            advertisers, or use it for cross-context behavioural
            advertising.
          </p>

          <h2>4. How long we keep your data</h2>
          <ul>
            <li>
              <strong>Account data</strong>: for as long as your
              account is active. After account deletion, we keep a
              minimal record for 30 days to handle disputes and
              chargebacks, then permanently delete.
            </li>
            <li>
              <strong>Product images</strong>: 30 days after a listing
              goes live on Jumia (Jumia keeps its own copies), or until
              you delete the listing or close your account if that
              comes first. Photos not attached to any listing are
              deleted 7 days after upload. On closure, deleted after
              the 30-day grace period.
            </li>
            <li>
              <strong>Unfinished listings</strong>: drafts you never
              submitted, and listings Jumia rejected, are deleted 2 days
              after they were created. Listings that went live stay in
              your history.
            </li>
            <li>
              <strong>Jumia tokens</strong>: until you disconnect
              Jumia, delete your account, or the tokens expire and
              are not refreshed.
            </li>
            <li>
              <strong>Payment records</strong>: 7 years from the date
              of the transaction, as required for tax and accounting
              purposes under Ghanaian law.
            </li>
            <li>
              <strong>Server logs</strong>: typically 30-90 days,
              depending on Vercel&apos;s retention defaults.
            </li>
          </ul>

          <h2>5. Your rights</h2>
          <p>
            Under the Ghana Data Protection Act, 2012, you have the
            right to:
          </p>
          <ul>
            <li>
              <strong>Access</strong> — request a copy of the
              personal data we hold about you.
            </li>
            <li>
              <strong>Correct</strong> — fix data that is inaccurate
              or incomplete. Most account fields are editable
              directly in the app.
            </li>
            <li>
              <strong>Delete</strong> — request deletion of your
              account and all associated data. Use Settings →
              Account → Delete account, or email support. Some data
              (tax records, fraud-prevention logs) may be retained
              where law requires.
            </li>
            <li>
              <strong>Restrict or object</strong> — to specific
              processing activities. Contact us via support.
            </li>
            <li>
              <strong>Portability</strong> — receive your listing
              data in a machine-readable format. The in-app{" "}
              <em>Export listings</em> feature provides a CSV/XLSX
              download.
            </li>
            <li>
              <strong>Withdraw consent</strong> — disconnect Jumia
              any time from Settings → Integrations. Your AI
              analysis and listings stay intact; only the Jumia push
              capability is removed.
            </li>
          </ul>
          <p>
            To exercise any of these rights, contact us via the
            in-app support button or email{" "}
            <a
              href="mailto:help.pandaworldai@gmail.com"
              className="text-orange-600 underline"
            >
              help.pandaworldai@gmail.com
            </a>
            . We respond within 30 days.
          </p>

          <h2>6. Data security</h2>
          <p>
            We take reasonable technical and organisational measures
            to protect your data, including:
          </p>
          <ul>
            <li>AES-256-GCM encryption of OAuth tokens and app secrets at rest.</li>
            <li>TLS for all data in transit between you, our servers, and third parties.</li>
            <li>Server-side rate limiting on expensive routes.</li>
            <li>Magic-byte validation of uploaded images (we reject files that don&apos;t match their declared type).</li>
            <li>Server-side input validation on all write endpoints.</li>
            <li>Least-privilege database credentials (only our server reads or writes — your data is not exposed to client-side code).</li>
          </ul>
          <p>
            No system is 100% secure. If we become aware of a data
            breach affecting your personal data, we will notify you
            without undue delay via email.
          </p>

          <h2>7. International transfers</h2>
          <p>
            Some of our processors (Clerk, Vercel, Google, PhotoRoom,
            Supabase) operate outside Ghana. By using the Service you
            consent to your data being transferred internationally
            where necessary for service operation. We rely on the
            standard contractual clauses and equivalent safeguards
            offered by each provider.
          </p>

          <h2>8. Children</h2>
          <p>
            The Service is not intended for users under 18. We do not
            knowingly collect personal data from anyone under 18. If
            you believe we have inadvertently collected such data,
            contact us and we will delete it.
          </p>

          <h2>9. Changes to this Policy</h2>
          <p>
            We may update this Policy from time to time. Material
            changes will be communicated via email or an in-app notice
            at least 14 days before they take effect. The
            &quot;Last updated&quot; date at the top of this page
            tracks revisions.
          </p>

          <h2>10. Contact</h2>
          <p>
            Questions about this Policy or about how your data is
            handled? Reach us via the WhatsApp support button inside
            the app, or email{" "}
            <a
              href="mailto:help.pandaworldai@gmail.com"
              className="text-orange-600 underline"
            >
              help.pandaworldai@gmail.com
            </a>
            . To make a formal complaint about data handling, you may
            also contact Ghana&apos;s Data Protection Commission at{" "}
            <a
              href="https://dataprotection.org.gh"
              target="_blank"
              rel="noopener noreferrer"
              className="text-orange-600 underline"
            >
              dataprotection.org.gh
            </a>
            .
          </p>

          <hr />
          <p className="text-xs text-zinc-500">
            <strong>Notice:</strong> This document is a draft template.
            Before launching publicly, have it reviewed by a Ghana-qualified
            lawyer to confirm compliance with the Data Protection Act, 2012
            (Act 843) and to nominate a Data Protection Officer if your
            processing volume requires one.
          </p>
        </div>
      </main>

      <MarketingFooter />
    </div>
  );
}

function SimpleNav({ active }: { active: "terms" | "privacy" }) {
  return (
    <header className="sticky top-0 z-20 border-b border-zinc-100 bg-white/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link href="/" aria-label="pandaworld home">
          <Wordmark size={28} />
        </Link>
        <nav className="flex items-center gap-1 sm:gap-4">
          {(["terms", "privacy"] as const).map((page) => (
            <Link
              key={page}
              href={`/${page}`}
              aria-current={active === page ? "page" : undefined}
              className={
                active === page
                  ? "rounded-md px-3 py-1.5 text-sm font-semibold text-zinc-900"
                  : "rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900"
              }
            >
              {page === "terms" ? "Terms" : "Privacy"}
            </Link>
          ))}
          <Link
            href="/pricing"
            className="rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900"
          >
            Pricing
          </Link>
          <Link
            href="/sign-up"
            className="rounded-md bg-orange-500 px-3 py-1.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-orange-600"
          >
            Get started
          </Link>
        </nav>
      </div>
    </header>
  );
}
