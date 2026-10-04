import Image from "next/image";

/**
 * The two ways to send a batch to the WhatsApp bot, as the bot offers them
 * after "how many products?" (lib/whatsapp/intake.ts handleAwaitingCount):
 * I, every product's photos captioned and closed by its number, with the
 * worked example the bot itself sends (public/whatsapp/quiet-mode-example.jpg);
 * II, the bot guiding each product. Shown with the WhatsApp guide on
 * /how-to and /how-to/list-on-jumia-from-whatsapp.
 */
export function WhatsAppSendingModes() {
  return (
    <section>
      <h3 className="text-lg font-bold text-zinc-900">Two ways to send your products</h3>
      <p className="mt-2 text-base text-zinc-600">
        After you say how many products you&apos;re listing, the bot asks how you want to send them. Tap{" "}
        <strong>#I</strong> or <strong>#II</strong>.
      </p>

      <div className="mt-5 grid gap-5 sm:grid-cols-2">
        <div className="rounded-xl border border-zinc-200 p-5">
          <p className="text-sm font-semibold uppercase tracking-wide text-orange-600">#I · All at once</p>
          <p className="mt-2 font-semibold text-zinc-900">Send every product, each followed by its number</p>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-relaxed text-zinc-600">
            <li>Select all the photos of product 1, type its price and any notes as the caption (e.g. <em>GHS 120. Capacity 1.8L</em>), and send.</li>
            <li>Send <strong>1</strong> once product 1&apos;s photos are all in.</li>
            <li>Do the same for product 2 and send <strong>2</strong>, and so on to the last one.</li>
            <li>The bot stays quiet until the last number, then drafts everything at once.</li>
          </ol>
          <p className="mt-3 text-sm text-zinc-500">
            Know the category? Add it to the caption, e.g. <em>Category: Wigs</em>, and the bot will use it.
          </p>
        </div>

        <div className="rounded-xl border border-zinc-200 p-5">
          <p className="text-sm font-semibold uppercase tracking-wide text-orange-600">#II · Guide me each step</p>
          <p className="mt-2 font-semibold text-zinc-900">The bot takes you through one product at a time</p>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-relaxed text-zinc-600">
            <li>Send the product&apos;s photos with its price and any notes: variations, sizes, sale price.</li>
            <li>Reply <strong>done</strong> when that product is complete.</li>
            <li>The bot confirms how many photos it got and asks for the next product.</li>
            <li>After the last one, it drafts everything.</li>
          </ol>
          <p className="mt-3 text-sm text-zinc-500">Best for your first batch, or when you&apos;d like a check after each product.</p>
        </div>
      </div>

      <figure className="mx-auto mt-6 max-w-[300px]">
        <Image
          src="/whatsapp/quiet-mode-example.jpg"
          alt="Example WhatsApp chat for way I: three products, each sent as a photo with its price as the caption and followed by its number, then the bot's reply that it's drafting all three"
          width={1080}
          height={1912}
          className="h-auto w-full rounded-2xl border border-zinc-200"
        />
        <figcaption className="mt-2 text-center text-sm text-zinc-500">Way I, as the bot shows it when you pick it.</figcaption>
      </figure>
    </section>
  );
}
