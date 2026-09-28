import { PadlockIcon } from "@/components/marketing/padlock-icon";

/** Where a step shows Vendor Center's padlock icon (lib/marketing/guides.ts). */
const PADLOCK = "{padlock}";

function StepText({ text }: { text: string }) {
  const parts = text.split(PADLOCK);
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {part}
          {i < parts.length - 1 && <PadlockIcon />}
        </span>
      ))}
    </>
  );
}

/** A guide's numbered steps. */
export function GuideSteps({ steps }: { steps: string[] }) {
  return (
    <ol className="space-y-2.5 border-l border-zinc-200 pl-5">
      {steps.map((step, j) => (
        <li key={j} className="flex gap-3 text-base text-zinc-600">
          <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-orange-50 text-sm font-bold text-orange-600">
            {j + 1}
          </span>
          <span className="min-w-0 leading-relaxed [overflow-wrap:anywhere]"><StepText text={step} /></span>
        </li>
      ))}
    </ol>
  );
}
