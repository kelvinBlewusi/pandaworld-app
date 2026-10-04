/**
 * The PandaWorld YouTube videos, in one place for the website
 * (lib/marketing/guides.ts) and the WhatsApp bot (lib/whatsapp/onboarding.ts).
 * Plain data with no React imports, so the bot can use it too. A video
 * re-uploaded on YouTube changes here only.
 */

/** A video on the PandaWorld YouTube channel. */
export interface YouTubeVideo {
  /** youtu.be/<id> */
  id: string;
  /** ISO 8601, for the VideoObject markup (components/marketing/video-ld.tsx). */
  duration: string;
  uploadDate: string;
}

export const VIDEOS = {
  walkthrough:         { id: "kcmy3jnEFZk", duration: "PT3M59S", uploadDate: "2026-10-04" },
  linkWhatsApp:        { id: "XDoao0IO7RM", duration: "PT1M4S",  uploadDate: "2026-10-04" },
  connectVendorCenter: { id: "FTQmSdMNuNE", duration: "PT1M55S", uploadDate: "2026-10-04" },
  listFromWhatsApp:    { id: "YRoahiccZdI", duration: "PT2M9S",  uploadDate: "2026-10-04" },
  chromeExtension:     { id: "JKv7b81M7fE", duration: "PT1M47S", uploadDate: "2026-10-04" },
} satisfies Record<string, YouTubeVideo>;

export function youtubeUrl(video: YouTubeVideo): string {
  return "https://youtu.be/" + video.id;
}
