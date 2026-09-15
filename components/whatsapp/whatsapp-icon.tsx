/**
 * The WhatsApp glyph, for the places this app talks about WhatsApp.
 *
 * Replaces lucide's MessageCircle, which is a generic speech bubble — it
 * read as "chat", not as "the thing on your phone". Nine call sites all
 * meant the same specific product, and a seller scanning a sidebar or a
 * connect card recognises the mark long before they read the label.
 *
 * Inherits currentColor rather than hard-coding WhatsApp green. Every
 * place this renders already sits on a deliberate surface — an emerald
 * tile, white on a green gradient, white on the orange marketing tile —
 * so a fixed green would fight the design at each one. A `brand` prop was
 * written for light neutral surfaces and then removed: nowhere needed it,
 * and a prop kept for a case that does not exist is just dead code with a
 * justification attached.
 *
 * Single path on a transparent ground rather than the green-disc lockup:
 * the disc is the app-icon form and looks wrong at 16px inside a text
 * button. Meta's brand guidelines allow the glyph for indicating an
 * integration, which is exactly what every use here is.
 */
export function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51a12.8 12.8 0 0 0-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884a9.82 9.82 0 0 1 6.988 2.896 9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.885-9.885 9.885M20.52 3.449C18.24 1.245 15.24 0 12.045 0 5.463 0 .104 5.359.101 11.945c0 2.096.549 4.142 1.595 5.945L0 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.582 0 11.94-5.359 11.943-11.945a11.87 11.87 0 0 0-3.416-8.4" />
    </svg>
  );
}
