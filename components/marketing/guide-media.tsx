import { PlayCircle } from "lucide-react";
import { WhatsAppFlowVideo } from "@/components/marketing/whatsapp-flow-video";
import type { Guide } from "@/lib/marketing/guides";

/** A guide's video: our own recording, its YouTube video, or a "coming soon" slot. */
export function GuideMedia({ guide }: { guide: Guide }) {
  if (guide.recording === "whatsapp-flow") {
    // Portrait phone recording: phone width, not the 16:9 slot.
    return (
      <div className="mx-auto max-w-[280px]">
        <WhatsAppFlowVideo />
      </div>
    );
  }
  if (guide.videoId) {
    return (
      <div className="aspect-video overflow-hidden rounded-xl border border-zinc-200">
        <iframe
          src={`https://www.youtube.com/embed/${guide.videoId}`}
          title={guide.title}
          className="h-full w-full"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
        />
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
