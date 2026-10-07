import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { KeyRound, Smartphone } from "lucide-react";
import { listExtensionApiKeys } from "@/lib/security/extension-keys";
import { RegenerateKeyButton } from "@/components/extension/regenerate-key-button";
import { WhatsAppCard } from "@/components/whatsapp/whatsapp-card";
import { JumiaConnectionCard } from "@/components/jumia/jumia-connection-card";
import { InstallApp } from "@/components/install/install-app";

export const metadata: import("next").Metadata = {
  title: "Settings",
  robots: { index: false },
};

function formatDate(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default async function ExtensionSettingsPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in?redirect_url=/extension/settings");

  const [user, keys] = await Promise.all([currentUser(), listExtensionApiKeys(userId)]);
  const activeKey = keys.find((k) => !k.revokedAt) ?? null;

  return (
    <div className="mx-auto max-w-2xl">
      {/* The orange "SETTINGS" eyebrow that used to sit here is gone. The
          sidebar already names the page, so it was the word Settings
          twice on one screen — and in a colour this page uses nowhere
          else, which made the duplicate the loudest thing on it. */}
      <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Account</h1>

      <div className="mt-6 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-semibold text-zinc-700">Your details</h2>
        <dl className="mt-3 space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-zinc-500">Name</dt>
            <dd className="font-medium text-zinc-900">
              {user?.firstName ? `${user.firstName}${user.lastName ? " " + user.lastName : ""}` : user?.username ?? "—"}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-zinc-500">Email</dt>
            <dd className="font-medium text-zinc-900">{user?.primaryEmailAddress?.emailAddress ?? "—"}</dd>
          </div>
        </dl>
      </div>

      <div className="mt-6">
        <JumiaConnectionCard returnTo="/extension/settings" />
      </div>

      <div className="mt-6">
        <WhatsAppCard />
      </div>

      <div className="mt-6 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-orange-600" />
          <h2 className="text-sm font-semibold text-zinc-700">API key</h2>
        </div>
        {activeKey ? (
          <p className="mt-2 text-sm text-zinc-600">
            <span className="font-mono text-xs text-zinc-500">pw_live_&hellip;{activeKey.suffix}</span> — created{" "}
            {formatDate(activeKey.createdAt)} · last used {formatDate(activeKey.lastUsedAt)}
          </p>
        ) : (
          <p className="mt-2 text-sm text-zinc-600">No key yet — visit the Dashboard to get one.</p>
        )}
        <p className="mt-2 text-xs text-zinc-500">
          View or copy your key from the Dashboard. Regenerating replaces it immediately — you&apos;ll
          need to paste the new one into the extension.
        </p>
        <div className="mt-4">
          <RegenerateKeyButton />
        </div>
      </div>

      {/* On the phone's home screen like an app (owner, 2026-10-07). */}
      <div className="mt-6 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <Smartphone className="h-4 w-4 text-orange-600" />
          <h2 className="text-sm font-semibold text-zinc-700">Install PandaWorld on your phone</h2>
        </div>
        <p className="mt-2 text-sm text-zinc-600">
          Put PandaWorld on your home screen and open it like an app: the Listing Assistant, your listings and your credits in one tap.
          Tap your phone for the steps.
        </p>
        <InstallApp className="mt-4" />
      </div>
    </div>
  );
}
