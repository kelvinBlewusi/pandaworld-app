"use client";

/**
 * The Listing Assistant (owner, 2026-10-07): the WhatsApp bot as a chat on
 * the dashboard, with photo upload. Everything the bot does but orders and
 * labels: list products from photos, edit and submit drafts, change live
 * products, answer questions about the shop. The bot is the same code
 * (lib/whatsapp/listing-assistant.ts); this page sends what the seller
 * types, uploads or taps, and polls for the bot's replies, drawing its
 * buttons, lists and links the way WhatsApp would.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowUp, ChevronDown, ChevronLeft, ExternalLink, ImagePlus, Loader2, Lock, Plus, RotateCw, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { BuyCreditsButton } from "@/components/billing/buy-credits-button";
import { matchingCommands, slashCommand, slashToText, unfinishedFill, type PaletteCommand } from "@/components/assistant/chat-commands";

interface Message {
  id:        string;
  clientId:  string | null;
  direction: "inbound" | "outbound";
  type:      string;
  text:      string | null;
  payload:   Record<string, unknown> | null;
  at:        string;
  /** Sent from this page and not yet read back from the server. */
  local?:    boolean;
  failed?:   boolean;
  /** What a message that didn't send needs to go again: Resend under it. */
  retry?:    Retry;
}

/** A message as the page sends it; a photo that never uploaded keeps its file. */
interface Retry { text?: string; mediaId?: string; mediaIds?: string[]; label?: string; last?: boolean; file?: File }

interface Attachment { key: string; file: File; preview: string }

type Button = { id: string; title: string };
type Row = { id: string; title: string; description?: string };

/** Photos picked at once (owner): Jumia takes at most 8 per product. */
const MAX_PHOTOS = 8;
const POLL_MS = 2500;
const POLL_WAITING_MS = 1200;
/** How long "typing…" shows after a message with no reply yet. */
const WAIT_MS = 90_000;

const SUGGESTIONS = [
  "I want to list 3 products",
  "What can you do?",
  "What's out of stock?",
  "How many orders did I get this week?",
  "My credits",
];

const newId = () => `web-${crypto.randomUUID()}`;
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** WhatsApp's own formatting: *bold*, _italic_, ~strike~, and links. Built from React nodes, never HTML. */
function Formatted({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <>
      {lines.map((line, i) => (
        <span key={i}>
          {line.split(/(https?:\/\/[^\s]+|\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g).map((part, j) => {
            if (/^https?:\/\//.test(part)) {
              const url = part.replace(/[.,!?)]+$/, "");
              return (
                <a key={j} href={url} target="_blank" rel="noopener noreferrer" className="break-all underline underline-offset-2">
                  {part}
                </a>
              );
            }
            if (/^\*[^*\n]+\*$/.test(part)) return <strong key={j} className="font-semibold">{part.slice(1, -1)}</strong>;
            if (/^_[^_\n]+_$/.test(part)) return <em key={j}>{part.slice(1, -1)}</em>;
            if (/^~[^~\n]+~$/.test(part)) return <s key={j}>{part.slice(1, -1)}</s>;
            return <span key={j}>{part}</span>;
          })}
          {i < lines.length - 1 && <br />}
        </span>
      ))}
    </>
  );
}

export function ListingAssistant({ firstName }: { firstName?: string | null }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // At 0 credits: the bot says to top up once, then the chat locks until the balance is above 0 (owner, 2026-10-07).
  const [locked, setLocked] = useState(false);
  // Until Jumia is connected the chat takes only the Client ID and token (owner, 2026-10-07).
  const [connectJumia, setConnectJumia] = useState(false);
  // The command menu: "/" typed in the box, or the + button (owner, 2026-10-07).
  const [commandsOpen, setCommandsOpen] = useState(false);
  // "Clear chat" (owner, 2026-10-07): asked first, then the chat starts over as on a first visit.
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const lastAt = useRef<string | null>(null);
  const clearedAt = useRef<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const textArea = useRef<HTMLTextAreaElement>(null);

  /** Merge what the server has into the list: its copy replaces a message's placeholder. */
  const merge = useCallback((incoming: Message[]) => {
    if (incoming.length === 0) return;
    lastAt.current = incoming[incoming.length - 1].at;
    setMessages((prev) => {
      const seen = new Set(prev.filter((m) => !m.local).map((m) => m.id));
      const fresh = incoming.filter((m) => !seen.has(m.id));
      const confirmed = new Set(fresh.map((m) => m.clientId).filter(Boolean));
      return [...prev.filter((m) => !(m.local && confirmed.has(m.clientId))), ...fresh];
    });
    if (incoming.some((m) => m.direction === "outbound")) setWaitingSince(null);
  }, []);

  const poll = useCallback(async () => {
    try {
      const q = lastAt.current ? `?after=${encodeURIComponent(lastAt.current)}` : "";
      const res = await fetch(`/api/listing-assistant/messages${q}`, { cache: "no-store" });
      if (!res.ok) return;
      const { messages: got, locked: isLocked, connectJumia: needsJumia, clearedAt: cleared } =
        (await res.json()) as { messages: Message[]; locked?: boolean; connectJumia?: boolean; clearedAt?: string | null };
      // Cleared since (here, in another tab, or by tapping the bot's Clear chat): what came before goes.
      if (cleared && cleared !== clearedAt.current) {
        const first = clearedAt.current === null;
        clearedAt.current = cleared;
        if (!first) setMessages((prev) => prev.filter((m) => !m.local && m.at > cleared));
      }
      merge(got);
      setLocked(Boolean(isLocked));
      setConnectJumia(Boolean(needsJumia));
    } catch {
      // The next poll tries again.
    } finally {
      setLoaded(true);
    }
  }, [merge]);

  // First load, then poll: faster while a reply is awaited, and only while the tab is open.
  useEffect(() => {
    void poll();
  }, [poll]);
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void poll();
    }, waitingSince ? POLL_WAITING_MS : POLL_MS);
    return () => clearInterval(t);
  }, [poll, waitingSince]);
  useEffect(() => {
    if (!waitingSince) return;
    const t = setTimeout(() => setWaitingSince(null), WAIT_MS);
    return () => clearTimeout(t);
  }, [waitingSince]);

  // Keep the newest message in view: straight there on first load, smoothly
  // after. Scrolled up to read, they stay where they are: the down arrow
  // takes them back, with a dot when something new came in (owner,
  // 2026-10-07: "a down arrow ... when moved back a bit").
  const firstScroll = useRef(true);
  const nearBottom = useRef(true);
  const autoUntil = useRef(0);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(false);
  const toBottom = useCallback((smooth = true) => {
    const el = scroller.current;
    if (!el) return;
    autoUntil.current = Date.now() + 800;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    nearBottom.current = true;
    setAtBottom(true);
    setUnseen(false);
  }, []);
  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    // A smooth scroll down passes through "not at the bottom": not a reason to show the arrow.
    if (!near && Date.now() < autoUntil.current) return;
    nearBottom.current = near;
    setAtBottom(near);
    if (near) setUnseen(false);
  }, []);
  useEffect(() => {
    if (messages.length === 0) return;
    const mine = messages[messages.length - 1]?.local;
    if (firstScroll.current || nearBottom.current || mine) toBottom(!firstScroll.current);
    else setUnseen(true);
    firstScroll.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, waitingSince, toBottom]);
  // A photo that loads after that grows the chat: stay at the bottom if they were there.
  const onMedia = useCallback(() => {
    const el = scroller.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 600) el.scrollTo({ top: el.scrollHeight });
  }, []);

  // Previews are object URLs: released when a photo is removed or sent, and on leaving.
  const previews = useRef<Attachment[]>([]);
  previews.current = attachments;
  useEffect(() => () => previews.current.forEach((a) => URL.revokeObjectURL(a.preview)), []);
  const release = (list: Attachment[]) => list.forEach((a) => URL.revokeObjectURL(a.preview));

  function addFiles(files: FileList | File[] | null) {
    if (!files) return;
    const images = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) {
      setError("Only photos can be sent here (JPEG, PNG or WebP).");
      return;
    }
    const room = MAX_PHOTOS - attachments.length;
    if (room <= 0) {
      setError(`Up to ${MAX_PHOTOS} photos at a time. Send these first.`);
      return;
    }
    setError(images.length > room ? `Up to ${MAX_PHOTOS} photos at a time, so only the first ${room} were added.` : null);
    setAttachments((prev) => [
      ...prev,
      ...images.slice(0, MAX_PHOTOS - prev.length).map((file) => ({ key: newId(), file, preview: URL.createObjectURL(file) })),
    ]);
  }

  /** One message to the bot. The placeholder shows at once; the server's copy replaces it. */
  async function post(body: Omit<Retry, "file">, placeholder: Omit<Message, "id" | "clientId" | "direction" | "at">) {
    const id = newId();
    const local: Message = { ...placeholder, id, clientId: id, direction: "inbound", at: new Date().toISOString(), local: true, retry: body };
    setMessages((prev) => [...prev, local]);
    setWaitingSince(Date.now());
    const res = await fetch("/api/listing-assistant/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...body }),
    }).catch(() => null);
    if (!res || !res.ok) {
      const msg = res ? ((await res.json().catch(() => ({}))) as { error?: string }).error : null;
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, failed: true } : m)));
      setError(msg ?? "That didn't send. Check your connection, then tap Resend under it.");
      setWaitingSince(null);
      return false;
    }
    // The bot answers within the request (drafting results come later, after
    // its "drafting now"), so once it's back, what it said is there to read.
    await poll();
    setWaitingSince(null);
    return true;
  }

  async function send(override?: { text: string; label?: string }) {
    if (sending || locked) return;
    const raw = (override?.text ?? text).trim();
    if (!override && slashCommand(raw)?.action === "clear") {
      setText("");
      setCommandsOpen(false);
      setConfirmClear(true);
      return;
    }
    // "/polish 2" goes as the words the bot knows: "polish 2".
    const typed = raw.startsWith("/") ? slashToText(raw) : raw;
    setCommandsOpen(false);
    const photos = override ? [] : attachments;
    const bare = !override && photos.length === 0 ? unfinishedFill(typed) : null;
    if (bare) {
      setText(bare.fill ?? "");
      setError(`Say which product and what to change, e.g. "${bare.example}".`);
      textArea.current?.focus();
      return;
    }
    if (!typed && photos.length === 0) return;
    setSending(true);
    setError(null);
    try {
      if (!override) {
        setText("");
        setAttachments([]);
      }
      // Photos all upload at once and go as one message, an album, the
      // words as its caption (owner, 2026-10-07: "sent at a go, currently
      // they are sent one after the other"). One that doesn't upload stays
      // in the chat, its preview kept, with Resend under it; the rest still go.
      const ups = await Promise.all(photos.map((p) => upload(p.file)));
      const good: { photo: Attachment; mediaId: string; url?: string }[] = [];
      const unsent: Attachment[] = [];
      photos.forEach((photo, i) => {
        const up = ups[i];
        if ("error" in up) unsent.push(photo);
        else good.push({ photo, mediaId: up.mediaId, url: up.url });
      });
      if (good.length > 0) {
        const links = good.map((g) => g.url ?? g.photo.preview);
        await post(
          { mediaIds: good.map((g) => g.mediaId), ...(typed ? { text: typed } : {}) },
          { type: "image", text: typed || null, payload: links.length > 1 ? { link: links[0], links } : { link: links[0] } },
        );
      }
      unsent.forEach((photo, i) => unsentPhoto(photo, { file: photo.file, last: true, ...(good.length === 0 && i === 0 && typed ? { text: typed } : {}) }));
      if (unsent.length > 0) {
        const failed = ups.find((u): u is { error: string | null } => "error" in u);
        setError(failed?.error ?? `${unsent.length === 1 ? "A photo" : `${unsent.length} photos`} didn't upload. Check your connection, then tap Resend under ${unsent.length === 1 ? "it" : "them"}.`);
      }
      // The page already has these files; the previews go once they're sent.
      setTimeout(() => release(good.map((g) => g.photo)), 60_000);
      if (typed && photos.length === 0) {
        await post(
          { text: typed, ...(override?.label ? { label: override.label } : {}) },
          { type: override?.label ? "interactive" : "text", text: typed, payload: override?.label ? { label: override.label } : null },
        );
      }
    } finally {
      setSending(false);
      textArea.current?.focus();
    }
  }

  /** A photo stored for the bot: its media id, or why it wasn't. */
  /** A command from the menu: sent as it is, or put in the box to finish. */
  function choose(c: PaletteCommand) {
    setCommandsOpen(false);
    if (c.action === "clear") {
      setText("");
      setConfirmClear(true);
      return;
    }
    if (c.send) {
      setText("");
      void send({ text: c.send });
      return;
    }
    setText(c.fill ?? "");
    textArea.current?.focus();
  }

  /** Clears the conversation: the bot starts over, the page shows the first-visit welcome. */
  async function clearChat() {
    setClearing(true);
    const res = await fetch("/api/listing-assistant/clear", { method: "POST" }).catch(() => null);
    setClearing(false);
    setConfirmClear(false);
    if (!res?.ok) {
      setError("The chat didn't clear. Check your connection and try again.");
      return;
    }
    const { clearedAt: cleared } = (await res.json().catch(() => ({}))) as { clearedAt?: string };
    if (cleared) clearedAt.current = cleared;
    release(attachments);
    setAttachments([]);
    setMessages([]);
    setError(null);
    setWaitingSince(null);
    lastAt.current = null;
    firstScroll.current = true;
    await poll();
  }

  async function upload(file: File): Promise<{ mediaId: string; url?: string } | { error: string | null }> {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/listing-assistant/upload", { method: "POST", body: form }).catch(() => null);
    const data = res ? ((await res.json().catch(() => ({}))) as { mediaId?: string; url?: string; error?: string }) : {};
    return res?.ok && data.mediaId ? { mediaId: data.mediaId, url: data.url } : { error: data.error ?? null };
  }

  /** A photo that never uploaded, shown from the page's own copy with Resend under it. */
  function unsentPhoto(photo: Attachment, retry: Retry) {
    setMessages((prev) => [...prev, {
      id: newId(), clientId: null, direction: "inbound", type: "image", text: retry.text ?? null,
      payload: { link: photo.preview }, at: new Date().toISOString(), local: true, failed: true, retry,
    }]);
  }

  /** Resend under a message that didn't go: the same words or photo, sent again. */
  async function resend(m: Message) {
    if (sending || !m.retry) return;
    const r = m.retry;
    setSending(true);
    setError(null);
    setMessages((prev) => prev.filter((x) => x.id !== m.id));
    try {
      if (r.file) {
        const up = await upload(r.file);
        if ("error" in up) {
          setMessages((prev) => [...prev, { ...m, at: new Date().toISOString() }]);
          setError(up.error ?? "The photo still didn't upload. Check your connection, then tap Resend again.");
          return;
        }
        const { file: _file, ...rest } = r;
        await post({ ...rest, mediaId: up.mediaId }, { type: "image", text: r.text ?? null, payload: m.payload });
      } else {
        await post(r, { type: m.type, text: m.text, payload: m.payload });
      }
    } finally {
      setSending(false);
    }
  }

  const tap = (b: Button) => void send({ text: b.id, label: b.title });
  const waiting = waitingSince != null;
  const empty = loaded && messages.length === 0;
  const greeting = useMemo(() => (firstName ? `Hi ${firstName}! ` : "Hi! "), [firstName]);

  return (
    // On a phone the chat is the whole screen (owner): it covers the app's top
    // bar and title card, keeping one slim row with a way back. From sm up
    // it's a card in the page.
    <div
      className={cn(
        "fixed inset-0 z-30 flex flex-col overflow-hidden bg-white",
        "sm:relative sm:inset-auto sm:z-auto sm:h-[calc(100dvh-13rem)] sm:min-h-[520px] sm:rounded-2xl sm:border sm:shadow-sm lg:h-[calc(100dvh-12rem)]",
        dragging ? "sm:border-orange-400 sm:ring-2 sm:ring-orange-200" : "sm:border-zinc-200",
      )}
      onDragOver={(e) => { e.preventDefault(); if (!locked) setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); if (!locked) addFiles(e.dataTransfer.files); }}
    >
      <div className="flex items-center gap-1 border-b border-zinc-100 px-2 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:gap-3 sm:px-5 sm:py-3">
        <Link
          href="/extension/dashboard"
          aria-label="Back to the dashboard"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-zinc-600 hover:bg-zinc-100 sm:hidden"
        >
          <ChevronLeft className="h-5 w-5" />
        </Link>
        {/* Our logo, not a generic sparkle (owner, 2026-10-07). */}
        <span className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-orange-50 sm:flex">
          <Image src="/brand/panda-p-logo-trimmed.png" alt="PandaWorld" width={634} height={562} className="h-6 w-auto" />
        </span>
        <div className="min-w-0">
          <p className="font-semibold text-zinc-900">Jumia Listing Assistant</p>
          <p className="hidden truncate text-xs text-zinc-500 sm:block">List from photos, edit and submit drafts, update live products, ask about your shop.</p>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} className="h-full space-y-3 overflow-y-auto bg-zinc-50/60 px-3 py-4 sm:px-5">
        {!loaded && (
          <div className="flex h-full items-center justify-center text-sm text-zinc-400">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading your conversation…
          </div>
        )}
        {empty && (
          <div className="mx-auto max-w-md pt-6 text-center">
            <Image src="/brand/panda-p-logo-trimmed.png" alt="PandaWorld" width={634} height={562} className="mx-auto h-14 w-auto" priority />
            <p className="mt-4 text-lg font-semibold text-zinc-900">{greeting}I&apos;m your Jumia Listing Assistant.</p>
            <p className="mt-2 text-sm leading-relaxed text-zinc-600">
              Tell me how many products you&apos;re listing, then upload each one&apos;s photos with its price and notes.
              I write the listings and send them to Jumia when you say so. Ask me about your stock, sales, payouts or credits too.
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void send({ text: s })}
                  className="rounded-full border border-zinc-200 bg-white px-3.5 py-2 text-sm text-zinc-700 transition-colors hover:border-orange-300 hover:bg-orange-50"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => <Bubble key={m.id} m={m} onTap={tap} onResend={resend} disabled={sending || locked} onMedia={onMedia} />)}

        {waiting && (
          <div className="flex items-center gap-2 pl-1 text-sm text-zinc-400">
            <span className="flex gap-1 rounded-2xl rounded-bl-md bg-white px-3.5 py-3 shadow-sm ring-1 ring-zinc-100">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.3s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.15s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400" />
            </span>
          </div>
        )}
      </div>
      {!atBottom && (
        <button
          type="button"
          onClick={() => toBottom()}
          aria-label="Go to the newest message"
          className="absolute bottom-3 left-1/2 flex h-10 w-10 -translate-x-1/2 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-600 shadow-md transition-colors hover:bg-zinc-50"
        >
          <ChevronDown className="h-5 w-5" />
          {unseen && <span className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full bg-orange-500 ring-2 ring-white" />}
        </button>
      )}
      </div>

      {connectJumia && !locked && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-orange-100 bg-orange-50 px-4 py-2 text-sm text-orange-900">
          <span>Connect Jumia to start: paste your Client ID and token below.</span>
          <span className="flex gap-3 text-sm font-semibold">
            <Link href="/how-to/connect-jumia-vendor-center" className="text-orange-700 hover:text-orange-800">How to get them</Link>
            <Link href="/extension/settings" className="text-orange-700 hover:text-orange-800">Settings</Link>
          </span>
        </div>
      )}

      {error && (
        <div className="flex items-start justify-between gap-3 border-t border-red-100 bg-red-50 px-4 py-2 text-sm text-red-700">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss" className="shrink-0 text-red-400 hover:text-red-600">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {locked ? (
        <div className="border-t border-zinc-100 bg-white p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:p-4">
          <div className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="flex items-start gap-2 text-sm text-amber-900">
              <Lock className="mt-0.5 h-4 w-4 shrink-0" />
              <span>You&apos;re out of credits, so the chat is locked. It unlocks as soon as you top up, or when a refund from Jumia&apos;s quality check comes in.</span>
            </p>
            <BuyCreditsButton className="shrink-0 self-start sm:self-auto" />
          </div>
        </div>
      ) : (
      <div className="relative border-t border-zinc-100 bg-white p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:p-4">
        {(commandsOpen || (text.startsWith("/") && !/\s/.test(text))) && (
          <CommandMenu
            commands={matchingCommands(commandsOpen && !text.startsWith("/") ? "" : text)}
            onChoose={choose}
            onClose={() => { setCommandsOpen(false); if (text.startsWith("/")) setText(""); }}
          />
        )}
        {attachments.length > 0 && (
          <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
            {attachments.map((a) => (
              <div key={a.key} className="relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-zinc-200">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={a.preview} alt="" className="h-full w-full object-cover" />
                <button
                  type="button"
                  onClick={() => { release([a]); setAttachments((prev) => prev.filter((x) => x.key !== a.key)); }}
                  className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white"
                  aria-label="Remove photo"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <input
            ref={fileInput}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            className="hidden"
            onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }}
          />
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={sending || attachments.length >= MAX_PHOTOS}
            className="flex h-11 shrink-0 items-center gap-2 rounded-xl border border-zinc-200 px-3 text-sm font-medium text-zinc-700 transition-colors hover:border-orange-300 hover:bg-orange-50 disabled:opacity-50"
            aria-label="Upload photos"
          >
            <ImagePlus className="h-5 w-5 text-orange-500" />
            <span className="hidden sm:inline">Upload</span>
          </button>
          <button
            type="button"
            onClick={() => setCommandsOpen((o) => !o)}
            disabled={sending}
            className={cn(
              "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-zinc-200 text-zinc-600 transition-colors hover:border-orange-300 hover:bg-orange-50 disabled:opacity-50",
              commandsOpen && "border-orange-300 bg-orange-50 text-orange-600",
            )}
            aria-label="Commands"
            aria-expanded={commandsOpen}
          >
            <Plus className="h-5 w-5" />
          </button>
          <textarea
            ref={textArea}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setCommandsOpen(false);
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files);
              if (files.length > 0) { e.preventDefault(); addFiles(files); }
            }}
            rows={1}
            placeholder={attachments.length > 0 ? "Price and notes for these photos…" : "Type / for commands"}
            // 16px on a phone: iOS zooms the page into a smaller field on focus.
            className="max-h-36 min-h-11 flex-1 resize-none rounded-xl border border-zinc-200 px-3.5 py-2.5 text-base text-zinc-900 sm:text-sm outline-none placeholder:text-zinc-400 focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={sending || (!text.trim() && attachments.length === 0)}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-orange-500 text-white transition-colors hover:bg-orange-600 disabled:bg-zinc-200 disabled:text-zinc-400"
            aria-label="Send"
          >
            {sending ? <Loader2 className="h-5 w-5 animate-spin" /> : <ArrowUp className="h-5 w-5" />}
          </button>
        </div>
      </div>
      )}

      {confirmClear && (
        <ClearDialog busy={clearing} onCancel={() => setConfirmClear(false)} onConfirm={() => void clearChat()} />
      )}

      {dragging && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-orange-50/80 text-sm font-semibold text-orange-700">
          Drop photos to add them
        </div>
      )}
    </div>
  );
}

/** The command menu, above the message box. */
function CommandMenu({ commands, onChoose, onClose }: { commands: PaletteCommand[]; onChoose: (c: PaletteCommand) => void; onClose: () => void }) {
  return (
    <div className="absolute inset-x-3 bottom-full z-10 mb-2 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-lg sm:inset-x-4" role="menu">
      <div className="flex items-center justify-between border-b border-zinc-100 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Commands</span>
        <button type="button" onClick={onClose} aria-label="Close commands" className="text-zinc-400 hover:text-zinc-600">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="max-h-72 overflow-y-auto py-1">
        {commands.length === 0 && <p className="px-3 py-2 text-sm text-zinc-500">No command by that name. Type your message instead.</p>}
        {commands.map((c) => (
          <button
            key={c.slash}
            type="button"
            role="menuitem"
            onClick={() => onChoose(c)}
            className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-orange-50"
          >
            <span className="w-24 shrink-0 font-mono text-sm text-orange-600">/{c.slash}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-zinc-900">{c.title}</span>
              <span className="block text-xs text-zinc-500">{c.hint}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** "Clear chat?", over the chat: what goes and what stays. */
function ClearDialog({ busy, onCancel, onConfirm }: { busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="absolute inset-0 z-20 flex items-end justify-center bg-black/30 p-3 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="clear-chat-title">
      <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-orange-50">
          <Trash2 className="h-5 w-5 text-orange-600" />
        </span>
        <p id="clear-chat-title" className="mt-3 font-semibold text-zinc-900">Clear this chat?</p>
        <p className="mt-1.5 text-sm leading-relaxed text-zinc-600">
          The conversation goes and the assistant starts fresh, like your first visit. Your drafts and listings stay on List from WhatsApp, and your credits don&apos;t change.
        </p>
        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="h-11 flex-1 rounded-xl border border-zinc-200 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-50"
          >
            Keep it
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-orange-500 text-sm font-semibold text-white transition-colors hover:bg-orange-600 disabled:opacity-60"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Clear chat
          </button>
        </div>
      </div>
    </div>
  );
}

function Bubble({ m, onTap, onResend, disabled, onMedia }: {
  m: Message; onTap: (b: Button) => void; onResend: (m: Message) => void; disabled: boolean; onMedia: () => void;
}) {
  const mine = m.direction === "inbound";
  const p = m.payload ?? {};
  const link = typeof p.link === "string" ? p.link : null;
  const album = Array.isArray(p.links) ? (p.links as unknown[]).filter((u): u is string => typeof u === "string") : [];
  const buttons = m.type === "button" && Array.isArray(p.buttons) ? (p.buttons as (Button | null)[]).filter((b): b is Button => !!b?.id) : [];
  const rows = m.type === "list" && Array.isArray(p.rows) ? (p.rows as Row[]).filter((r) => r?.id) : [];
  const cta = m.type === "cta_url" && typeof p.url === "string" ? { url: p.url, label: typeof p.buttonText === "string" ? p.buttonText : "Open" } : null;
  // A tap shows the button's words; an id from an older WhatsApp-style message reads as a tap.
  const label = typeof p.label === "string" ? p.label : null;
  const shown = mine && label ? label : m.text;

  return (
    <div className={cn("flex flex-col", mine ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[85%] overflow-hidden rounded-2xl text-sm leading-relaxed sm:max-w-[70%]",
          // The seller's own messages in a soft grey (owner, 2026-10-07), the bot's in white.
          mine ? "rounded-br-md bg-[#efefed] text-zinc-900" : "rounded-bl-md bg-white text-zinc-800 shadow-sm ring-1 ring-zinc-100",
          m.failed && "opacity-60",
        )}
      >
        {album.length > 1 ? (
          // Several photos at once: one message, a grid; each opens full size.
          <div className="grid w-72 max-w-full grid-cols-2 gap-0.5">
            {album.map((url, i) => (
              <a key={`${url}-${i}`} href={url} target="_blank" rel="noopener noreferrer" className={cn(album.length % 2 === 1 && i === 0 && "col-span-2")}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt={`Photo ${i + 1}`} className={cn("w-full object-cover", album.length % 2 === 1 && i === 0 ? "aspect-[2/1]" : "aspect-square")} onLoad={onMedia} />
              </a>
            ))}
          </div>
        ) : link && (
          <a href={link} target="_blank" rel="noopener noreferrer">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={link} alt="" className="max-h-64 w-full object-cover" onLoad={onMedia} />
          </a>
        )}
        {shown && (
          <div className={cn("whitespace-pre-wrap break-words px-3.5 py-2.5", link && "pt-2")}>
            <Formatted text={shown} />
          </div>
        )}
        {rows.length > 0 && (
          <div className="border-t border-zinc-100">
            {typeof p.buttonText === "string" && (
              <p className="px-3.5 pt-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">{p.buttonText}</p>
            )}
            {rows.map((r) => (
              <button
                key={r.id}
                type="button"
                disabled={disabled}
                onClick={() => onTap({ id: r.id, title: r.title })}
                className="block w-full border-b border-zinc-50 px-3.5 py-2 text-left last:border-b-0 hover:bg-orange-50 disabled:opacity-50"
              >
                <span className="block font-medium text-zinc-900">{r.title}</span>
                {r.description && <span className="block text-xs text-zinc-500">{r.description}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      {buttons.length > 0 && (
        <div className="mt-1.5 flex max-w-[85%] flex-wrap gap-1.5 sm:max-w-[70%]">
          {buttons.map((b) => (
            <button
              key={b.id}
              type="button"
              disabled={disabled}
              onClick={() => onTap(b)}
              className="rounded-full border border-orange-200 bg-white px-3.5 py-1.5 text-sm font-medium text-orange-700 transition-colors hover:bg-orange-50 disabled:opacity-50"
            >
              {b.title}
            </button>
          ))}
        </div>
      )}
      {cta && (
        <a
          href={cta.url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border border-orange-200 bg-white px-3.5 py-1.5 text-sm font-medium text-orange-700 transition-colors hover:bg-orange-50"
        >
          {cta.label} <ExternalLink className="h-3.5 w-3.5" />
        </a>
      )}
      {m.failed ? (
        <span className="mt-1 flex items-center gap-2 px-1 text-[11px]">
          <span className="text-red-500">Not sent</span>
          {m.retry && (
            <button
              type="button"
              onClick={() => onResend(m)}
              disabled={disabled}
              className="inline-flex items-center gap-1 rounded-full border border-red-200 bg-white px-2 py-0.5 font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50"
            >
              <RotateCw className="h-3 w-3" /> Resend
            </button>
          )}
        </span>
      ) : (
        <span className="mt-1 px-1 text-[11px] text-zinc-400">{m.local ? "Sending…" : time(m.at)}</span>
      )}
    </div>
  );
}
