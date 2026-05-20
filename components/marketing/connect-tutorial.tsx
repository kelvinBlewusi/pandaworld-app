/**
 * "How to connect PandaWorld to Jumia" — a 5-step illustrated
 * walkthrough on the public landing page. Each step shows a styled
 * mockup of the relevant Jumia Vendor Center panel so a prospective
 * seller can see exactly where to click before they sign up.
 *
 * Mockups are pure CSS — no real screenshots, no leaked credentials,
 * no asset wrangling when Jumia tweaks their UI. The look intentionally
 * mirrors Jumia's actual design tokens (orange accent stripe across
 * modal tops, neutral grays for sidebar / form, monospace for IDs) so
 * the visual continuity carries through when the seller lands in VC.
 */

import { ChevronUp, Copy, Lock, Trash2 } from "lucide-react";

export function ConnectTutorial() {
  return (
    <section id="how-to-connect" className="border-t border-zinc-100 bg-zinc-50">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <div className="text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-orange-500">
            5 minutes, one-time setup
          </p>
          <h2 className="mt-3 text-2xl font-bold sm:text-3xl">
            How to connect PandaWorld to Jumia
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-sm text-zinc-600">
            You&rsquo;ll create a small &ldquo;application&rdquo; inside Jumia Vendor Center
            that lets PandaWorld push listings to your store on your behalf.
            Here&rsquo;s exactly what to click.
          </p>
        </div>

        <ol className="mt-14 space-y-10">
          <Step
            n={1}
            title="Open Vendor Center settings"
            body={
              <p>
                Sign in at{" "}
                <a
                  href="https://vendorcenter.jumia.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-orange-600 hover:underline"
                >
                  vendorcenter.jumia.com
                </a>
                . In the top-right user menu, click <strong>Settings</strong>.
              </p>
            }
          >
            <MockUserMenu />
          </Step>

          <Step
            n={2}
            title="Navigate to Applications"
            body={
              <p>
                In the Settings sidebar, expand <strong>Seller Settings</strong>{" "}
                and pick <strong>Applications</strong>.
              </p>
            }
          >
            <MockSettingsSidebar />
          </Step>

          <Step
            n={3}
            title="Click Create Application"
            body={
              <p>
                You&rsquo;ll see a list of any existing apps. Hit the orange{" "}
                <strong>CREATE APPLICATION +</strong> button on the top-right.
              </p>
            }
          >
            <MockManageApplications />
          </Step>

          <Step
            n={4}
            title="Configure the app"
            body={
              <>
                <p>Fill the form:</p>
                <ul className="mt-2 space-y-1 text-sm text-zinc-600">
                  <li>
                    <strong>Application Name</strong>: anything memorable
                    (e.g. &ldquo;PandaWorld&rdquo;).
                  </li>
                  <li>
                    <strong>Application Type</strong>: pick{" "}
                    <strong>Web Application (OAuth)</strong> — NOT Self
                    Authorization. PandaWorld needs the user-consent flow.
                  </li>
                  <li>
                    <strong>Redirect URI</strong>: copy this exact URL from
                    your PandaWorld onboarding screen and paste it in:
                  </li>
                </ul>
                <CodeLine value="https://pandaworld.gh/api/jumia/callback" />
                <p className="mt-2 text-xs text-zinc-500">
                  Then click <strong>CREATE</strong>.
                </p>
              </>
            }
          >
            <MockCreateApplicationModal />
          </Step>

          <Step
            n={5}
            title="Copy your Client ID and Client Secret"
            body={
              <p>
                Jumia shows a one-time popup with your two credentials. Copy{" "}
                both, then paste them into the PandaWorld onboarding screen.
                You&rsquo;ll be redirected to authorise the app — that&rsquo;s it,
                you&rsquo;re connected.
              </p>
            }
          >
            <MockApplicationDetails />
          </Step>
        </ol>

        <div className="mx-auto mt-14 max-w-2xl rounded-xl border border-orange-200 bg-orange-50 p-5 text-sm text-orange-900">
          <p className="font-semibold">A note on security:</p>
          <p className="mt-1 text-orange-800">
            Your Client Secret is encrypted at rest the moment it reaches our
            database. If you ever delete the application from Jumia&rsquo;s
            side, PandaWorld will detect the broken connection on the next
            sync and prompt you to reconnect.
          </p>
        </div>
      </div>
    </section>
  );
}

// ─── Step wrapper ────────────────────────────────────────────────────────────

function Step({
  n,
  title,
  body,
  children,
}: {
  n:        number;
  title:    string;
  body:     React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <li className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:gap-10 items-start">
      <div>
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-orange-500 to-purple-600 text-base font-bold text-white shadow-md">
          {n}
        </div>
        <h3 className="mt-4 text-lg font-bold text-zinc-900">{title}</h3>
        <div className="mt-3 text-sm leading-relaxed text-zinc-600 space-y-2">
          {body}
        </div>
      </div>
      <div className="lg:pl-4">{children}</div>
    </li>
  );
}

// ─── Mockups — pure CSS, matching the Jumia VC visual language ───────────────
//
// Each mockup is a simplified card that captures the structure of the
// actual VC screen. Data is fake / redacted. The shared mockShell
// wrapper gives every panel the same shadow and rounded chrome so the
// tutorial reads as a coherent set.

function mockShell(extra: string = "") {
  return `relative rounded-xl border border-zinc-200 bg-white shadow-md overflow-hidden ${extra}`;
}

function MockUserMenu() {
  return (
    <div className={mockShell("max-w-[280px] mx-auto lg:mx-0")}>
      <div className="border-b border-orange-100 bg-orange-50 px-4 py-3">
        <span className="inline-flex items-center gap-2 rounded-md bg-orange-100 px-3 py-1.5 text-sm font-semibold text-orange-700">
          🏬 Choose Shops
        </span>
      </div>
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-full bg-zinc-200" />
          <div className="text-xs">
            <p className="font-semibold text-zinc-800">YOUR STORE</p>
            <p className="text-[10px] text-zinc-400">you@example.com</p>
          </div>
        </div>
        <ChevronUp className="h-4 w-4 text-zinc-400" />
      </div>
      <ul className="divide-y divide-zinc-100 text-sm">
        <li className="px-4 py-2.5 text-zinc-600">Give us your feedback!</li>
        <li className="bg-teal-100 px-4 py-2.5 font-medium text-teal-800">
          Settings
        </li>
        <li className="px-4 py-2.5 text-zinc-600">Profile</li>
        <li className="px-4 py-2.5 text-zinc-600">Logout</li>
      </ul>
    </div>
  );
}

function MockSettingsSidebar() {
  return (
    <div className={mockShell("max-w-[280px] mx-auto lg:mx-0")}>
      <div className="border-b border-zinc-100 px-4 py-2 text-xs text-zinc-500">
        Settings <span className="mx-1.5 text-zinc-300">&gt;</span>{" "}
        <span className="font-semibold text-orange-600">Applications</span>
      </div>
      <div className="px-4 py-4">
        <p className="text-sm font-semibold text-zinc-800">Seller Settings</p>
        <ul className="mt-3 space-y-1.5 text-sm">
          <li className="text-zinc-600">Users</li>
          <li className="font-medium text-teal-700">Applications</li>
          <li className="text-zinc-600">Holiday Mode</li>
          <li className="text-zinc-600">Shop Activation</li>
          <li className="text-zinc-600">Manage Pickers</li>
        </ul>
        <div className="mt-5 flex items-center justify-between border-t border-zinc-100 pt-3">
          <p className="text-sm font-semibold text-zinc-800">Platform Settings</p>
          <ChevronUp className="h-3.5 w-3.5 text-zinc-400" />
        </div>
      </div>
    </div>
  );
}

function MockManageApplications() {
  return (
    <div className={mockShell()}>
      <div className="flex items-center justify-between border-b border-zinc-100 bg-zinc-50/50 px-5 py-3">
        <p className="text-sm font-semibold text-zinc-700">Manage Applications</p>
        <button className="inline-flex items-center gap-1.5 rounded-md bg-orange-500 px-3 py-1.5 text-xs font-bold text-white shadow-sm">
          CREATE APPLICATION +
        </button>
      </div>
      <table className="w-full text-left text-xs">
        <thead className="border-b border-zinc-100 bg-zinc-50/30 text-zinc-500">
          <tr>
            <th className="px-5 py-2 font-medium">Name</th>
            <th className="px-2 py-2 font-medium">Application Type</th>
            <th className="px-2 py-2 font-medium">Client ID</th>
            <th className="px-2 py-2 font-medium">Created At</th>
            <th className="px-2 py-2 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-zinc-100 text-zinc-700">
            <td className="px-5 py-3 font-medium">YOUR STORE</td>
            <td className="px-2 py-3 text-zinc-500">Self Authorization</td>
            <td className="px-2 py-3 font-mono text-[10px] text-zinc-500">
              2c••••••-••••-••••-••••-••••91d493b•••a
            </td>
            <td className="px-2 py-3 text-zinc-500">Jul 10, 2025</td>
            <td className="px-2 py-3 text-zinc-400">
              <span className="inline-flex items-center gap-1.5">
                <Trash2 className="h-3 w-3" />
                <Lock className="h-3 w-3 text-orange-400" />
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function MockCreateApplicationModal() {
  return (
    <div className={mockShell()}>
      <div className="h-1 bg-gradient-to-r from-orange-500 to-orange-400" />
      <div className="space-y-4 px-6 py-5">
        <p className="text-base font-semibold text-zinc-900">Create Application</p>
        <div>
          <label className="text-[10px] font-semibold uppercase tracking-wider text-orange-500">
            Application Name *
          </label>
          <div className="mt-1 border-b border-orange-300 pb-1 text-sm text-zinc-700">
            PandaWorld
          </div>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            Application Type
          </p>
          <div className="mt-2 space-y-2">
            <label className="flex items-start gap-2 text-xs text-zinc-700">
              <span className="mt-1 flex h-3.5 w-3.5 items-center justify-center rounded-full border-2 border-orange-500">
                <span className="block h-1.5 w-1.5 rounded-full bg-orange-500" />
              </span>
              <span>
                <strong>Web Application (OAuth — Authorization Code Flow)</strong>
                <br />
                <span className="text-zinc-500">
                  PandaWorld uses this flow.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-xs text-zinc-500">
              <span className="mt-1 h-3.5 w-3.5 rounded-full border-2 border-zinc-300" />
              <span>
                Self Authorization (Integration without User interaction)
              </span>
            </label>
          </div>
        </div>
        <div>
          <label className="text-[10px] font-semibold uppercase tracking-wider text-orange-500">
            Redirect URI *
          </label>
          <div className="mt-1 border-b border-orange-300 pb-1 font-mono text-[11px] text-zinc-700">
            https://pandaworld.gh/api/jumia/callback
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 pt-2">
          <button className="text-xs font-medium text-zinc-500">CLOSE</button>
          <button className="rounded-md bg-orange-500 px-3 py-1.5 text-xs font-bold text-white shadow-sm">
            CREATE
          </button>
        </div>
      </div>
    </div>
  );
}

function MockApplicationDetails() {
  return (
    <div className={mockShell()}>
      <div className="h-1 bg-gradient-to-r from-orange-500 to-orange-400" />
      <div className="space-y-3 px-6 py-5 text-xs">
        <p className="text-base font-semibold text-zinc-900">
          Application Details
        </p>
        <Row label="Name" value="PandaWorld" />
        <Row
          label="Client ID"
          value="e8b74f30-688e-454a-abb8-•••••••••••8"
          copy
        />
        <Row
          label="Client Secret"
          value="sHcIhU_cPUE0ureWbUbqbuPlXqlPTdftoSRf0ck0Zll="
          copy
          mono
        />
        <Row label="Authentication Type" value="Web Application" />
        <Row
          label="Manage Applications"
          value="https://pandaworld.gh/api/…"
          copy
          mono
        />
        <div className="flex justify-end pt-1">
          <button className="text-xs font-bold uppercase tracking-wider text-orange-500">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  copy,
  mono,
}: {
  label: string;
  value: string;
  copy?: boolean;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-32 shrink-0 text-zinc-500">{label}:</span>
      <span
        className={`flex-1 truncate text-zinc-700 ${mono ? "font-mono text-[10px]" : ""}`}
      >
        {value}
      </span>
      {copy && <Copy className="h-3 w-3 shrink-0 text-zinc-400" />}
    </div>
  );
}

function CodeLine({ value }: { value: string }) {
  return (
    <div className="mt-3 flex items-center justify-between rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-[11px]">
      <code className="truncate font-mono text-zinc-700">{value}</code>
      <Copy className="h-3 w-3 shrink-0 text-zinc-400" />
    </div>
  );
}
