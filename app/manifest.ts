import type { MetadataRoute } from "next";

/**
 * PandaWorld as an app on the seller's home screen (owner, 2026-10-07:
 * install buttons in Settings and the footer, components/install). There's
 * no store app: this manifest is what "Add to Home Screen" (iPhone) and
 * "Install app" (Android Chrome) read. It opens on the dashboard, full
 * screen, with the panda icon.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "PandaWorld: Jumia Listing Assistant",
    short_name: "PandaWorld",
    description: "List on Jumia from photos, run your orders and check your shop, from your phone.",
    id: "/",
    start_url: "/extension/dashboard",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#ffffff",
    theme_color: "#f97316",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
