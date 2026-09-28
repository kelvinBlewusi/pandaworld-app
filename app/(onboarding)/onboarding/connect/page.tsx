"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  ExternalLink,
  Copy,
  Check,
  Eye,
  EyeOff,
  Loader2,
  CheckCircle2,
  XCircle,
  ShieldCheck,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

const progressSteps = ["Connect", "Done"];

const COUNTRIES = [
  { code: "GH", label: "Ghana 🇬🇭",      url: "vendorcenter.jumia.com.gh"  },
  { code: "NG", label: "Nigeria 🇳🇬",    url: "vendorcenter.jumia.com.ng"  },
  { code: "KE", label: "Kenya 🇰🇪",      url: "vendorcenter.jumia.co.ke"   },
  { code: "EG", label: "Egypt 🇪🇬",      url: "vendorcenter.jumia.com.eg"  },
  { code: "MA", label: "Morocco 🇲🇦",    url: "vendorcenter.jumia.ma"      },
  { code: "SN", label: "Senegal 🇸🇳",    url: "vendorcenter.jumia.sn"      },
  { code: "CI", label: "Ivory Coast 🇨🇮",url: "vendorcenter.jumia.ci"      },
  { code: "TZ", label: "Tanzania 🇹🇿",   url: "vendorcenter.jumia.co.tz"   },
  { code: "UG", label: "Uganda 🇺🇬",     url: "vendorcenter.jumia.co.ug"   },
];

function StepCircle({ n, done }: { n: number; done?: boolean }) {
  return (
    <div className={cn(
      "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold",
      done ? "bg-emerald-100 text-emerald-600" : "bg-orange-100 text-orange-600"
    )}>
      {done ? <Check className="h-3.5 w-3.5" /> : n}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
      className="ml-2 shrink-0 rounded-md border border-zinc-200 p-1.5 text-zinc-400 transition-colors hover:border-zinc-300 hover:text-zinc-700"
      title="Copy to clipboard"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

/** Appends ?return_to=<returnTo> to a same-origin path when returnTo is
 *  set — see lib/jumia/return-to.ts. Client-side mirror of that file's
 *  sanitizeReturnTo (kept inline rather than imported to avoid pulling a
 *  server-oriented module into this "use client" page for one check). */
function withReturnTo(path: string, returnTo: string | null): string {
  if (!returnTo || !returnTo.startsWith("/") || returnTo.startsWith("//")) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}return_to=${encodeURIComponent(returnTo)}`;
}

function ConnectPageInner() {
  const searchParams = useSearchParams();
  const returnTo = searchParams.get("return_to");

  // Reached from (main)/layout.tsx's gate when a connection row exists but
  // needs re-authorization (refresh token stopped working — see
  // markNeedsReconnect in lib/jumia/api.ts). app_id/app_secret are already
  // on file and never change, so this is a single click straight to
  // Jumia's OAuth screen via /api/jumia/connect (same shortcut Settings →
  // Integrations' "Re-authorise" button uses) — not the full form below,
  // which is only for a seller who's never connected at all.
  const [reconnecting, setReconnecting] = useState(false);
  // Escape hatch: if the seller deleted or recreated the OAuth application
  // in Jumia Vendor Center (Settings → Applications), the stored app_id is
  // no longer valid and clicking "Re-authorise" sends them straight into
  // Jumia's raw, unbranded "unable to retrieve client by id" error page —
  // a dead end, since that page has no link back into PandaWorld. This lets
  // them bail out to the full credentials form instead of getting stuck.
  const [showFullForm, setShowFullForm] = useState(false);
  if (searchParams.get("reason") === "disconnected" && !showFullForm) {
    return (
      <div className="mx-auto max-w-[600px] rounded-2xl border bg-white shadow-sm overflow-hidden">
        <div className="border-b bg-gradient-to-r from-orange-50 to-amber-50 px-6 py-5 flex items-center gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-orange-400 to-orange-500 text-2xl shadow-sm">
            🛒
          </div>
          <div>
            <h1 className="text-lg font-bold text-zinc-900">Reconnect Jumia</h1>
            <p className="text-sm text-zinc-500">Your access needs to be renewed</p>
          </div>
        </div>
        <div className="px-6 py-6 space-y-4">
          <p className="text-sm text-zinc-600">
            Your Jumia session expired. Connections made with a <strong>Web Application</strong> expire about a
            day after each login. Switch to a <strong>Self Authorization</strong> application once and PandaWorld
            keeps you connected from then on, with no more logins.
          </p>
          <Button
            className="w-full h-11 gap-2 bg-gradient-to-r from-orange-400 to-orange-500 hover:from-orange-500 hover:to-orange-600 text-white"
            onClick={() => setShowFullForm(true)}
          >
            Stay connected automatically (2 minutes)
          </Button>
          <button
            type="button"
            disabled={reconnecting}
            onClick={() => { setReconnecting(true); window.location.href = withReturnTo("/api/jumia/connect", returnTo); }}
            className="flex w-full items-center justify-center gap-1.5 text-center text-xs text-zinc-500 hover:text-zinc-700 hover:underline"
          >
            {reconnecting ? (
              <><Loader2 className="h-3.5 w-3.5 animate-spin" />Redirecting to Jumia…</>
            ) : (
              <><RefreshCw className="h-3.5 w-3.5" />Just log in again for now (expires in about a day)</>
            )}
          </button>
        </div>
      </div>
    );
  }

  return <ConnectForm returnTo={returnTo} />;
}

/**
 * The default: a Jumia Self Authorization application. Jumia gives refresh
 * tokens only to this kind, so the connection renews itself
 * (lib/jumia/self-auth.ts, /api/worker/jumia-keepalive) and the seller
 * never has to log in again. The seller pastes the app's Client ID and a
 * token from its Generate Token button; there's no redirect to Jumia.
 */
function ConnectForm({ returnTo }: { returnTo: string | null }) {
  const [webApp, setWebApp] = useState(false);
  if (webApp) return <WebAppForm returnTo={returnTo} onBack={() => setWebApp(false)} />;
  return <SelfAuthForm returnTo={returnTo} onWebApp={() => setWebApp(true)} />;
}

function SelfAuthForm({ returnTo, onWebApp }: { returnTo: string | null; onWebApp: () => void }) {
  const [clientId, setClientId] = useState("");
  const [token, setToken] = useState("");
  const [country, setCountry] = useState("GH");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/jumia/self-auth", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ clientId: clientId.trim(), refreshToken: token.trim(), country }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        window.location.href = withReturnTo(`/onboarding/done?store=${encodeURIComponent(data.storeName ?? "Jumia Store")}`, returnTo);
        return;
      }
      setError(data.error ?? "Couldn't connect. Check the Client ID and generate a new token.");
    } catch {
      setError("Network error — please try again.");
    }
    setPending(false);
  }

  const canConnect = clientId.trim().length > 0 && token.trim().length > 0 && !pending;

  return (
    <div className="mx-auto max-w-[600px] overflow-hidden rounded-2xl border bg-white shadow-sm">
      <div className="flex items-center gap-4 border-b bg-gradient-to-r from-orange-50 to-amber-50 px-6 py-5">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-orange-400 to-orange-500 text-2xl shadow-sm">
          🛒
        </div>
        <div>
          <h1 className="text-lg font-bold text-zinc-900">Connect Jumia</h1>
          <p className="text-sm text-zinc-500">Set it up once. PandaWorld keeps it connected from then on.</p>
        </div>
      </div>

      <div className="divide-y">
        <div className="space-y-3 px-6 py-5">
          <div className="flex items-center gap-3">
            <StepCircle n={1} />
            <p className="text-sm font-semibold text-zinc-800">Open Jumia Vendor Center</p>
          </div>
          <div className="ml-10">
            <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" asChild>
              <a href="https://vendorcenter.jumia.com" target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-3.5 w-3.5" />
                Open Vendor Center
              </a>
            </Button>
          </div>
        </div>

        <div className="space-y-3 px-6 py-5">
          <div className="flex items-center gap-3">
            <StepCircle n={2} />
            <p className="text-sm font-semibold text-zinc-800">Create a Self Authorization application</p>
          </div>
          <div className="ml-10 space-y-1.5 text-sm text-zinc-500">
            <p>
              Go to <span className="font-medium text-zinc-700">Settings → Applications → Create Application</span>.
            </p>
            <p>
              Choose <span className="font-medium text-zinc-700">Self Authorization</span> and name it{" "}
              <span className="font-medium text-zinc-700">PandaWorld</span>. No redirect URL is needed.
            </p>
          </div>
        </div>

        <div className="space-y-3 px-6 py-5">
          <div className="flex items-center gap-3">
            <StepCircle n={3} />
            <p className="text-sm font-semibold text-zinc-800">Generate a token</p>
          </div>
          <div className="ml-10 space-y-1.5 text-sm text-zinc-500">
            <p>
              On the Manage Applications screen, find PandaWorld and click the{" "}
              <span className="font-medium text-zinc-700">orange lock icon</span> (Generate Token) in the Actions column.
            </p>
            <p>Copy the token, and the application&apos;s <span className="font-medium text-zinc-700">Client ID</span>.</p>
          </div>
        </div>

        <div className="space-y-4 px-6 py-5">
          <div className="flex items-center gap-3">
            <StepCircle n={4} />
            <p className="text-sm font-semibold text-zinc-800">Paste them here</p>
          </div>
          <div className="ml-10 space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-zinc-600">Country</Label>
              <Select value={country} onValueChange={setCountry}>
                <SelectTrigger className="h-9 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {COUNTRIES.map((c) => <SelectItem key={c.code} value={c.code}>{c.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-zinc-600">Client ID</Label>
              <Input
                placeholder="e.g. ed0b5856-3612-5829-b8de-d95774bfcf17"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                className="h-9 font-mono text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-zinc-600">Generated token</Label>
              <textarea
                placeholder="Paste the token from the orange lock icon"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                rows={3}
                className="w-full rounded-md border border-zinc-200 px-3 py-2 font-mono text-xs text-zinc-800 focus:outline-none focus:ring-2 focus:ring-orange-200"
              />
              <p className="text-xs text-zinc-400">Paste it straight away: a generated token only works for a short time.</p>
            </div>
            {error && (
              <p className="flex items-start gap-1.5 text-xs text-red-500">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-3 border-t bg-zinc-50 px-6 py-4">
        <p className="flex items-center gap-2 text-xs text-zinc-400">
          <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-500" />
          Your token is encrypted and never shared. PandaWorld renews it in the background so you stay connected.
        </p>
        <Button
          className="h-11 w-full gap-2 bg-gradient-to-r from-orange-400 to-orange-500 text-white hover:from-orange-500 hover:to-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!canConnect}
          onClick={connect}
        >
          {pending ? <><Loader2 className="h-4 w-4 animate-spin" />Connecting…</> : "Connect Jumia →"}
        </Button>
        <button type="button" onClick={onWebApp} className="w-full text-center text-xs text-zinc-400 hover:text-zinc-600 hover:underline">
          Already made a Web Application? Use it instead (you&apos;ll need to log in again about once a day)
        </button>
      </div>
    </div>
  );
}

/**
 * The older route: a Jumia Web Application and a login redirect. Jumia
 * never gives these a refresh token, so the connection lasts about a day
 * per login. Kept for sellers who already made one.
 */
function WebAppForm({ returnTo, onBack }: { returnTo: string | null; onBack: () => void }) {
  const [redirectUri, setRedirectUri] = useState("");
  const [appId, setAppId]             = useState("");
  const [secretKey, setSecretKey]     = useState("");
  const [country, setCountry]         = useState("GH");
  const [showSecret, setShowSecret]   = useState(false);

  const [testStatus, setTestStatus]   = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [testMessage, setTestMessage] = useState("");
  const [connecting, setConnecting]   = useState(false);

  const selectedCountry = COUNTRIES.find((c) => c.code === country) ?? COUNTRIES[0];

  useEffect(() => {
    setRedirectUri(`${window.location.origin}/api/jumia/callback`);
  }, []);

  async function handleTest() {
    if (!appId.trim() || !secretKey.trim()) return;
    setTestStatus("loading");
    setTestMessage("");
    try {
      const res = await fetch("/api/jumia/test-credentials", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ appId: appId.trim(), secretKey: secretKey.trim(), country }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setTestStatus("ok");
        setTestMessage(data.message ?? "Credentials verified.");
      } else {
        setTestStatus("error");
        setTestMessage(data.error ?? "Credentials could not be verified. Double-check your Client ID and Client Secret.");
      }
    } catch {
      setTestStatus("error");
      setTestMessage("Network error — please try again.");
    }
  }

  async function handleConnect() {
    setConnecting(true);
    try {
      const res = await fetch("/api/jumia/save-credentials", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ appId: appId.trim(), secretKey: secretKey.trim(), storeName: "", country }),
      });
      const data = await res.json();
      if (res.ok) {
        // Credentials saved — now kick off the real OAuth flow.
        // /api/jumia/connect reads the saved app_id and redirects to Jumia's
        // authorize page; after the seller approves, the callback stores a real
        // access_token and sends them to /onboarding/done.
        window.location.href = withReturnTo("/api/jumia/connect", returnTo);
      } else {
        setTestStatus("error");
        setTestMessage(data.error ?? "Failed to save credentials — please try again.");
        setConnecting(false);
      }
    } catch {
      setTestStatus("error");
      setTestMessage("Network error — please try again.");
      setConnecting(false);
    }
  }

  const canTest    = appId.trim().length > 0 && secretKey.trim().length > 0;
  const canConnect = canTest && testStatus === "ok"; // store name optional — OAuth callback sets real name

  return (
    <div className="space-y-6">
      {/* Progress bar */}
      <div className="flex items-center justify-center gap-2">
        {progressSteps.map((step, i) => (
          <div key={step} className="flex items-center gap-2">
            <div className={cn(
              "flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold",
              i === 0 ? "bg-fuchsia-500 text-white shadow-lg shadow-fuchsia-500/40" : "bg-white/10 text-white/40"
            )}>
              {i + 1}
            </div>
            <span className={cn("text-xs", i === 0 ? "font-medium text-white" : "text-white/35")}>
              {step}
            </span>
            {i < progressSteps.length - 1 && (
              <div className="h-px w-8 bg-white/15" />
            )}
          </div>
        ))}
      </div>

      {/* Main card */}
      <div className="mx-auto max-w-[600px] rounded-2xl border bg-white shadow-sm overflow-hidden">
        {/* Header */}
        <div className="border-b bg-gradient-to-r from-orange-50 to-amber-50 px-6 py-5 flex items-center gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-orange-400 to-orange-500 text-2xl shadow-sm">
            🛒
          </div>
          <div>
            <h1 className="text-lg font-bold text-zinc-900">Connect Jumia</h1>
            <p className="text-sm text-zinc-500">
              Follow these steps to link your Vendor Center account
            </p>
          </div>
        </div>

        <div className="divide-y">
          {/* Step 1 — Log in */}
          <div className="px-6 py-5 space-y-3">
            <div className="flex items-center gap-3">
              <StepCircle n={1} />
              <p className="text-sm font-semibold text-zinc-800">Log into Jumia Vendor Center</p>
            </div>
            <p className="ml-10 text-sm text-zinc-500">
              Go to{" "}
              <a
                href="https://vendorcenter.jumia.com"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-orange-600 hover:underline"
              >
                vendorcenter.jumia.com
              </a>{" "}
              and sign in to your seller account.
            </p>
            <div className="ml-10">
              <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" asChild>
                {/* Generic vendorcenter.jumia.com — Jumia 302-redirects to
                    the seller's country VC after sign-in, so a single URL
                    works regardless of which country the seller picked
                    above. Matches the inline text link directly above. */}
                <a href="https://vendorcenter.jumia.com" target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-3.5 w-3.5" />
                  Open Vendor Center
                </a>
              </Button>
            </div>
          </div>

          {/* Step 2 — Create app */}
          <div className="px-6 py-5 space-y-3">
            <div className="flex items-center gap-3">
              <StepCircle n={2} />
              <p className="text-sm font-semibold text-zinc-800">Create an API application</p>
            </div>
            <div className="ml-10 space-y-2 text-sm text-zinc-500">
              <p>
                Navigate to{" "}
                <span className="font-medium text-zinc-700">
                  Settings → Applications → Create Application
                </span>
              </p>
              <p>
                Choose:{" "}
                <span className="font-medium text-zinc-700">Web Application (OAuth)</span>
              </p>
              <p className="mt-2">Set the Redirect URI to:</p>
              <div className="flex items-center rounded-lg border bg-zinc-50 px-3 py-2 font-mono text-xs text-zinc-700">
                <span className="flex-1 break-all">{redirectUri || "Loading…"}</span>
                {redirectUri && <CopyButton text={redirectUri} />}
              </div>
            </div>
          </div>

          {/* Step 3 — Copy credentials */}
          <div className="px-6 py-5 space-y-3">
            <div className="flex items-center gap-3">
              <StepCircle n={3} />
              <p className="text-sm font-semibold text-zinc-800">Copy your credentials</p>
            </div>
            <div className="ml-10 text-sm text-zinc-500">
              <p>After creating the app, copy your:</p>
              <ul className="mt-2 space-y-1 pl-4 list-disc text-zinc-600">
                <li><span className="font-medium">Client ID</span></li>
                <li><span className="font-medium">Client Secret</span></li>
              </ul>
            </div>
          </div>

          {/* Step 4 — Form */}
          <div className="px-6 py-5 space-y-4">
            <div className="flex items-center gap-3">
              <StepCircle n={4} done={testStatus === "ok"} />
              <p className="text-sm font-semibold text-zinc-800">Paste them below</p>
            </div>

            <div className="ml-10 space-y-4">
              {/* Country */}
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-zinc-600">Country</Label>
                <Select value={country} onValueChange={(v) => { setCountry(v); setTestStatus("idle"); }}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {COUNTRIES.map((c) => (
                      <SelectItem key={c.code} value={c.code}>{c.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Client ID */}
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-zinc-600">Client ID</Label>
                <Input
                  placeholder="e.g. ed0b5856-3612-5829-b8de-d95774bfcf17"
                  value={appId}
                  onChange={(e) => { setAppId(e.target.value); setTestStatus("idle"); }}
                  className="h-9 text-sm font-mono"
                />
              </div>

              {/* Client Secret */}
              <div className="space-y-1.5">
                <Label className="text-xs font-medium text-zinc-600">Client Secret</Label>
                <div className="relative">
                  <Input
                    type={showSecret ? "text" : "password"}
                    placeholder="e.g. mXTNC33WFlKak2XfLFwmihiOOrZ5O1itDQ7djAStTwc="
                    value={secretKey}
                    onChange={(e) => { setSecretKey(e.target.value); setTestStatus("idle"); }}
                    className="h-9 pr-10 text-sm font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSecret((s) => !s)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600"
                  >
                    {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {/* Test connection row */}
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 gap-2 text-xs"
                  disabled={!canTest || testStatus === "loading"}
                  onClick={handleTest}
                >
                  {testStatus === "loading" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Test Connection
                </Button>
                {testStatus === "ok" && (
                  <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-600">
                    <CheckCircle2 className="h-4 w-4" /> {testMessage}
                  </span>
                )}
                {testStatus === "error" && (
                  <span className="flex items-center gap-1.5 text-xs text-red-500">
                    <XCircle className="h-4 w-4" /> {testMessage}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t bg-zinc-50 px-6 py-4 space-y-3">
          <p className="flex items-center gap-2 text-xs text-zinc-400">
            <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-500" />
            Your credentials are encrypted and never shared.
          </p>
          <Button
            className="w-full h-11 gap-2 bg-gradient-to-r from-orange-400 to-orange-500 hover:from-orange-500 hover:to-orange-600 text-white disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={!canConnect || connecting}
            onClick={handleConnect}
          >
            {connecting ? (
              <><Loader2 className="h-4 w-4 animate-spin" />Connecting…</>
            ) : (
              "Connect Jumia →"
            )}
          </Button>
          <button type="button" onClick={onBack} className="w-full text-center text-xs text-zinc-400 hover:text-zinc-600 hover:underline">
            ← Use a Self Authorization application instead (stays connected)
          </button>
        </div>
      </div>
    </div>
  );
}

// useSearchParams() requires a Suspense boundary — same pattern
// Settings → Integrations uses for the same reason.
export default function ConnectPage() {
  return (
    <Suspense fallback={null}>
      <ConnectPageInner />
    </Suspense>
  );
}
