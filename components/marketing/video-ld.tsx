import type { YouTubeVideo } from "@/lib/marketing/videos";

/**
 * VideoObject structured data for a YouTube video on the page, so Google
 * can show the video (thumbnail, length) in results for the guide's search
 * and in video search.
 */
export function VideoLd({ video, name, description }: { video: YouTubeVideo; name: string; description: string }) {
  const ld = {
    "@context":   "https://schema.org",
    "@type":      "VideoObject",
    name,
    description,
    thumbnailUrl: `https://i.ytimg.com/vi/${video.id}/maxresdefault.jpg`,
    uploadDate:   video.uploadDate,
    duration:     video.duration,
    embedUrl:     `https://www.youtube.com/embed/${video.id}`,
  };
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }} />;
}
