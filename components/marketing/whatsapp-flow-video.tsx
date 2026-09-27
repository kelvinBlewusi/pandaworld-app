/**
 * Screen recording of the whole WhatsApp flow — a real 3-product batch
 * from "how many products?" to the drafted listings, ending on a "Live on
 * Jumia" notification. Used on the homepage ("See it happen") and the
 * Guides page ("Use the WhatsApp Chatbot").
 *
 * Re-encoded from the 13 MB phone capture to 720px wide H.264 (3.4 MB),
 * which is still sharp at the ~300px it's shown at. Click to play rather
 * than autoplay, with preload="none": most visitors are on mobile data,
 * and an autoplaying video would download all of it for everyone who
 * scrolls past. The poster shows the finished result until they tap.
 *
 * A plain <video>, so it renders on the server like the rest of both
 * pages — no client component needed.
 */
export function WhatsAppFlowVideo({ className = "" }: { className?: string }) {
  return (
    <video
      src="/marketing/whatsapp-flow.mp4"
      poster="/marketing/whatsapp-flow-poster.jpg"
      width={720}
      height={1558}
      controls
      playsInline
      preload="none"
      aria-label="Screen recording: listing 3 products to Jumia from a WhatsApp chat with PandaWorld AI"
      className={`h-auto w-full rounded-[1.75rem] border border-zinc-200 bg-zinc-100 shadow-md ${className}`}
    />
  );
}
