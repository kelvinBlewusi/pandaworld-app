"use client";

import { useState } from "react";
import { Unlink, RefreshCw, Bell, Shield, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { mockStores } from "@/lib/mock/stores";
import { cn } from "@/lib/utils";

export default function AccountSettingsPage() {
  const [notifications, setNotifications] = useState({
    listingApproved: true,
    listingFailed: true,
    weeklyReport: false,
    newFeatures: true,
  });

  const [warranty, setWarranty] = useState({
    defaultMonths: "12",
    type: "Seller warranty",
  });

  return (
    <div className="space-y-8 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold text-zinc-900">Account settings</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Manage your profile, connected stores, and preferences.
        </p>
      </div>

      {/* Profile */}
      <section className="rounded-2xl border bg-white p-6 shadow-sm space-y-5">
        <div className="flex items-center gap-3">
          <User className="h-4 w-4 text-zinc-400" />
          <h2 className="text-sm font-semibold text-zinc-700">Profile</h2>
        </div>
        <Separator />
        <div className="flex items-center gap-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-orange-400 to-pink-500 text-2xl font-bold text-white shadow-sm">
            K
          </div>
          <div>
            <p className="font-semibold text-zinc-800">Kelvin</p>
            <p className="text-sm text-zinc-400">kelvinblewu@gmail.com</p>
            <p className="mt-0.5 text-xs text-zinc-400">Free plan · Member since Jan 2026</p>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Display name</Label>
            <Input defaultValue="Kelvin" />
          </div>
          <div className="space-y-1.5">
            <Label>Email</Label>
            <Input defaultValue="kelvinblewu@gmail.com" type="email" />
          </div>
          <div className="space-y-1.5">
            <Label>Phone number</Label>
            <Input placeholder="+233 …" />
          </div>
          <div className="space-y-1.5">
            <Label>Country</Label>
            <Input defaultValue="Ghana" />
          </div>
        </div>
        <Button>Save profile</Button>
      </section>

      {/* Connected stores */}
      <section className="rounded-2xl border bg-white p-6 shadow-sm space-y-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Shield className="h-4 w-4 text-zinc-400" />
            <h2 className="text-sm font-semibold text-zinc-700">Connected stores</h2>
          </div>
          <Button variant="outline" size="sm" asChild>
            <a href="/onboarding/channel">Add store</a>
          </Button>
        </div>
        <Separator />
        <div className="space-y-3">
          {mockStores.map((store) => (
            <div
              key={store.id}
              className="flex items-center gap-4 rounded-xl border p-4"
            >
              <div
                className={cn(
                  "flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br text-base shrink-0",
                  store.avatarColor
                )}
              >
                🛒
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-zinc-800 truncate">
                  {store.storeName}
                </p>
                <p className="text-xs text-zinc-400 truncate">{store.email}</p>
                <p className="text-xs text-zinc-400">
                  {store.listingsCount} listings · Connected {store.connectedAt}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-xs font-medium",
                    store.status === "connected"
                      ? "bg-emerald-50 text-emerald-600"
                      : "bg-red-50 text-red-500"
                  )}
                >
                  {store.status === "connected" ? "Connected" : "Expired"}
                </span>
                {store.status === "expired" ? (
                  <Button variant="outline" size="sm" className="gap-1 h-7 text-xs">
                    <RefreshCw className="h-3 w-3" />
                    Reconnect
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1 h-7 text-xs text-red-400 hover:text-red-600"
                  >
                    <Unlink className="h-3 w-3" />
                    Disconnect
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Default warranty */}
      <section className="rounded-2xl border bg-white p-6 shadow-sm space-y-5">
        <div className="flex items-center gap-3">
          <Shield className="h-4 w-4 text-zinc-400" />
          <h2 className="text-sm font-semibold text-zinc-700">Default warranty preferences</h2>
        </div>
        <Separator />
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Default warranty period (months)</Label>
            <Input
              type="number"
              value={warranty.defaultMonths}
              onChange={(e) =>
                setWarranty((w) => ({ ...w, defaultMonths: e.target.value }))
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label>Default warranty type</Label>
            <Input
              value={warranty.type}
              onChange={(e) =>
                setWarranty((w) => ({ ...w, type: e.target.value }))
              }
            />
          </div>
        </div>
        <p className="text-xs text-zinc-400">
          These defaults are pre-filled when you create a new listing.
        </p>
        <Button>Save defaults</Button>
      </section>

      {/* Notifications */}
      <section className="rounded-2xl border bg-white p-6 shadow-sm space-y-5">
        <div className="flex items-center gap-3">
          <Bell className="h-4 w-4 text-zinc-400" />
          <h2 className="text-sm font-semibold text-zinc-700">Notifications</h2>
        </div>
        <Separator />
        <div className="space-y-4">
          {[
            {
              key: "listingApproved" as const,
              label: "Listing approved",
              desc: "When Jumia approves one of your listings",
            },
            {
              key: "listingFailed" as const,
              label: "Listing failed",
              desc: "When a listing fails review or publishing",
            },
            {
              key: "weeklyReport" as const,
              label: "Weekly performance report",
              desc: "Summary of your listings and earnings every Monday",
            },
            {
              key: "newFeatures" as const,
              label: "New PandaWorld features",
              desc: "Product updates and new capabilities",
            },
          ].map((item) => (
            <div key={item.key} className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-zinc-800">{item.label}</p>
                <p className="text-xs text-zinc-400">{item.desc}</p>
              </div>
              <Switch
                checked={notifications[item.key]}
                onCheckedChange={(v) =>
                  setNotifications((n) => ({ ...n, [item.key]: v }))
                }
              />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
