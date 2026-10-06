/**
 * A notice's text (lib/notices.ts): *word* is shown bold, everything else is
 * plain text. Built from React nodes, never raw HTML.
 */
export function RichText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*[^*\n]+\*)/g).map((part, i) =>
        /^\*[^*\n]+\*$/.test(part)
          ? <strong key={i} className="font-semibold text-zinc-900">{part.slice(1, -1)}</strong>
          : <span key={i}>{part}</span>,
      )}
    </>
  );
}
