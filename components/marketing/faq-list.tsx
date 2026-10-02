import type { FaqSection } from "@/lib/marketing/faq";

/** The FAQ's sections as expandable questions (lib/marketing/faq.tsx). */
export function FaqList({ sections }: { sections: FaqSection[] }) {
  return (
    <div className="space-y-8">
      {sections.map((section) => (
        <section key={section.title}>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">{section.title}</h2>
          <div className="mt-3 divide-y divide-zinc-100 rounded-xl border border-zinc-200 bg-white">
            {section.items.map((item) => (
              <details key={item.q} className="group px-4 py-3">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-base font-medium text-zinc-900 [&::-webkit-details-marker]:hidden">
                  {item.q}
                  <span className="shrink-0 text-lg text-zinc-400 transition-transform group-open:rotate-45" aria-hidden>+</span>
                </summary>
                <div className="mt-2 text-sm leading-relaxed text-zinc-600 sm:text-base">{item.a}</div>
              </details>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
