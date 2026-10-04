import { PlayCircle } from "lucide-react";
import { WhatsAppFlowVideo } from "@/components/marketing/whatsapp-flow-video";
import type { Guide } from "@/lib/marketing/guides";
import type { YouTubeVideo } from "@/lib/marketing/videos";

/** A YouTube video in a 16:9 frame. Loads only once it's scrolled near, so a
 *  page of guides doesn't pull every player in on mobile data. */
export function YouTubeEmbed({ video, title }: { video: YouTubeVideo; title: string }) {
  return (
    <div className="aspect-video overflow-hidden rounded-xl border border-zinc-200">
      <iframe
        src={`https://www.youtube.com/embed/${video.id}`}
        title={title}
        loading="lazy"
        className="h-full w-full"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
      />
    </div>
  );
}

/** A guide's video: its YouTube video, our own recording, or a "coming soon" slot. */
export function GuideMedia({ guide }: { guide: Guide }) {
  if (guide.video) {
    return <YouTubeEmbed video={guide.video} title={guide.title} />;
  }
  if (guide.recording === "whatsapp-flow") {
    // Portrait phone recording: phone width, not the 16:9 slot.
    return (
      <div className="mx-auto max-w-[280px]">
        <WhatsAppFlowVideo />
      </div>
    );
  }
  return (
    <div className="flex aspect-video flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-200 bg-zinc-50 text-zinc-400">
      <PlayCircle className="h-9 w-9" />
      <span className="text-sm font-medium uppercase tracking-wide">Video coming soon</span>
    </div>
  );
}
