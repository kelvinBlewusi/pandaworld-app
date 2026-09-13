"use client";

/**
 * RichTextField — a working WYSIWYG editor that mirrors Jumia Vendor
 * Center's editor look (Paragraph dropdown + Bold/Italic/Link/Lists/
 * Indent/Image/Quote/Table/Video/Undo/Redo). All 13 buttons are wired
 * to real Tiptap commands.
 *
 * Used by SchemaField wherever the field type resolves to "textarea" —
 * that's Product description, Highlights, From the Manufacturer, What's
 * in the box, Product warranty, Warranty Address, and any other long-
 * form attribute Jumia surfaces. Output is HTML; Jumia VC accepts the
 * same tags we emit (<p>, <strong>, <em>, <ul>, <ol>, <li>, <a>, <img>,
 * <blockquote>, <table>, …) so what the seller sees here is what
 * renders on the live product page.
 *
 * Backwards-compat: existing DB values may be plain text — possibly with
 * "• " bullets from the AI's highlights output. `normaliseRichTextValue()`
 * converts those into a proper <ul> before the editor mounts, so the
 * bullets render as real list items instead of literal "• " characters.
 * Values that contain HTML anywhere are passed straight through.
 */

import { useEffect, useRef } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Image from "@tiptap/extension-image";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import Youtube from "@tiptap/extension-youtube";
import ListKeymap from "@tiptap/extension-list-keymap";

import {
  Bold, Italic, Link as LinkIcon,
  List, ListOrdered,
  IndentDecrease, IndentIncrease,
  Image as ImageIcon, Quote,
  Table as TableIcon, Video,
  Undo2, Redo2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { normaliseRichTextValue, escapeHtml } from "@/lib/utils/rich-text-value";

interface RichTextFieldProps {
  value:        string;
  onChange:     (v: string) => void;
  placeholder?: string;
  rows?:        number;       // hint for min-height — translated to min-h
  id?:          string;
}

// ─── Toolbar ──────────────────────────────────────────────────────────────────

function ToolbarButton({
  Icon, title, onClick, active = false, disabled = false,
}: {
  Icon:      typeof Bold;
  title:     string;
  onClick:   () => void;
  active?:   boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => e.preventDefault()} // keep editor focus
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "rounded p-1 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-700 disabled:cursor-not-allowed disabled:opacity-40",
        active && "bg-zinc-200 text-zinc-900",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

function ParagraphSelect({ editor }: { editor: Editor }) {
  // Read current heading level (or "p") for the displayed value
  const level =
    editor.isActive("heading", { level: 1 }) ? "h1" :
    editor.isActive("heading", { level: 2 }) ? "h2" :
    editor.isActive("heading", { level: 3 }) ? "h3" :
    "p";

  return (
    <select
      value={level}
      onMouseDown={(e) => e.preventDefault()}
      onChange={(e) => {
        const v = e.target.value;
        if (v === "p") {
          editor.chain().focus().setParagraph().run();
        } else {
          const lvl = parseInt(v.slice(1), 10) as 1 | 2 | 3;
          editor.chain().focus().toggleHeading({ level: lvl }).run();
        }
      }}
      className="rounded border border-zinc-200 bg-white px-1.5 py-0.5 text-[11px] text-zinc-600 focus:outline-none"
    >
      <option value="p">Paragraph</option>
      <option value="h1">Heading 1</option>
      <option value="h2">Heading 2</option>
      <option value="h3">Heading 3</option>
    </select>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  // Link prompt — wraps the current selection in an <a>. If nothing is
  // selected, prompts for both URL and link text and inserts both.
  const handleLink = () => {
    const previous = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Enter URL", previous ?? "https://");
    if (url === null) return; // cancelled
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    if (editor.state.selection.empty) {
      const linkText = window.prompt("Link text", url);
      if (linkText === null) return;
      editor
        .chain()
        .focus()
        .insertContent(`<a href="${url}">${escapeHtml(linkText || url)}</a>`)
        .run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  };

  const handleImage = () => {
    const url = window.prompt("Image URL", "https://");
    if (!url) return;
    editor.chain().focus().setImage({ src: url }).run();
  };

  const handleTable = () => {
    editor
      .chain()
      .focus()
      .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
      .run();
  };

  const handleYoutube = () => {
    const url = window.prompt(
      "YouTube URL (paste the full video link)",
      "https://www.youtube.com/watch?v=",
    );
    if (!url) return;
    editor.chain().focus().setYoutubeVideo({ src: url }).run();
  };

  // Indent / outdent: only meaningful inside a list. Outside one, the
  // buttons stay enabled (Tiptap returns false from these commands when
  // they don't apply, so they're effectively no-ops) but the typical UX
  // works as expected when the cursor IS in a list item.
  const handleSink = () => {
    if (editor.isActive("listItem")) {
      editor.chain().focus().sinkListItem("listItem").run();
    }
  };
  const handleLift = () => {
    if (editor.isActive("listItem")) {
      editor.chain().focus().liftListItem("listItem").run();
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-zinc-200 bg-zinc-50/50 px-2 py-1.5">
      <ParagraphSelect editor={editor} />
      <ToolbarButton
        Icon={Bold} title="Bold (⌘B)"
        active={editor.isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}
      />
      <ToolbarButton
        Icon={Italic} title="Italic (⌘I)"
        active={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      />
      <ToolbarButton
        Icon={LinkIcon} title="Link"
        active={editor.isActive("link")}
        onClick={handleLink}
      />
      <ToolbarButton
        Icon={List} title="Bulleted list"
        active={editor.isActive("bulletList")}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      />
      <ToolbarButton
        Icon={ListOrdered} title="Numbered list"
        active={editor.isActive("orderedList")}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      />
      <ToolbarButton
        Icon={IndentDecrease} title="Decrease indent (in lists)"
        onClick={handleLift}
      />
      <ToolbarButton
        Icon={IndentIncrease} title="Increase indent (in lists)"
        onClick={handleSink}
      />
      <ToolbarButton
        Icon={ImageIcon} title="Insert image by URL"
        onClick={handleImage}
      />
      <ToolbarButton
        Icon={Quote} title="Quote"
        active={editor.isActive("blockquote")}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      />
      <ToolbarButton
        Icon={TableIcon} title="Insert 3×3 table"
        onClick={handleTable}
      />
      <ToolbarButton
        Icon={Video} title="Embed YouTube video"
        onClick={handleYoutube}
      />
      <ToolbarButton
        Icon={Undo2} title="Undo (⌘Z)"
        disabled={!editor.can().undo()}
        onClick={() => editor.chain().focus().undo().run()}
      />
      <ToolbarButton
        Icon={Redo2} title="Redo (⌘⇧Z)"
        disabled={!editor.can().redo()}
        onClick={() => editor.chain().focus().redo().run()}
      />
    </div>
  );
}

// ─── Editor ──────────────────────────────────────────────────────────────────

export function RichTextField({
  value,
  onChange,
  placeholder,
  rows = 4,
  id,
}: RichTextFieldProps) {
  // Hold the latest onChange in a ref so we never need to recreate the
  // editor when the parent passes a new callback identity. Tiptap v3's
  // useEditor refreshes the editor whenever any option in the config
  // changes — including the onUpdate closure — so without this ref we
  // hit an infinite remount loop the moment the parent re-renders.
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  // Snapshot the initial value at mount only. Later value changes are
  // pushed in via the useEffect-with-setContent below — NOT via the
  // useEditor `content` option, which would trigger a refresh.
  const initialValueRef = useRef(normaliseRichTextValue(value));

  const editor = useEditor(
    {
      // Required in Next.js App Router (Tiptap v3) — defer initial render
      // to the client so SSR + hydration don't disagree on contents.
      immediatelyRender: false,
      extensions: [
        StarterKit.configure({
          // Heading levels capped at 3 to match the Paragraph dropdown
          heading: { levels: [1, 2, 3] },
        }),
        Link.configure({
          openOnClick: false,
          autolink: true,
          HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" },
        }),
        Image,
        Table.configure({ resizable: true }),
        TableRow,
        TableHeader,
        TableCell,
        Youtube.configure({ HTMLAttributes: { class: "rounded" } }),
        ListKeymap, // Tab/Shift-Tab inside lists
      ],
      content: initialValueRef.current,
      onUpdate({ editor }) {
        const html = editor.getHTML();
        // Tiptap emits "<p></p>" for an empty document — collapse that
        // back to "" so length-based required-field checks behave.
        onChangeRef.current(html === "<p></p>" ? "" : html);
      },
      editorProps: {
        attributes: {
          id: id ?? "",
          class: cn(
            "tiptap focus:outline-none px-3 py-2 text-sm",
            // Light prose-ish styling so headings + lists don't look broken
            "[&_h1]:text-lg [&_h1]:font-semibold [&_h1]:mb-2",
            "[&_h2]:text-base [&_h2]:font-semibold [&_h2]:mb-2",
            "[&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mb-1",
            "[&_p]:my-1",
            "[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5",
            "[&_li]:my-0.5",
            "[&_blockquote]:border-l-2 [&_blockquote]:border-zinc-300 [&_blockquote]:pl-3 [&_blockquote]:text-zinc-600 [&_blockquote]:italic",
            "[&_table]:border-collapse [&_table]:w-full",
            "[&_th]:border [&_th]:border-zinc-300 [&_th]:px-2 [&_th]:py-1 [&_th]:bg-zinc-50",
            "[&_td]:border [&_td]:border-zinc-200 [&_td]:px-2 [&_td]:py-1",
            "[&_a]:text-blue-600 [&_a]:underline",
            "[&_img]:max-w-full [&_img]:rounded",
          ),
          "data-placeholder": placeholder ?? "",
        },
      },
    },
    // CRITICAL: empty deps array pins the editor instance for the
    // component's lifetime. Without this, Tiptap v3 watches every
    // option for changes and refreshes the editor on every parent
    // re-render — including each keystroke when value is controlled
    // from above — which causes the infinite-remount loop the stack
    // trace shows (createExtensionManager → refreshEditorInstance →
    // commit → re-render → refreshEditorInstance → …).
    [],
  );

  // Keep the editor's content in sync if the parent replaces `value`
  // (e.g. AI regenerate overwrites the description). We compare against
  // the editor's current HTML to avoid clobbering mid-typing state.
  useEffect(() => {
    if (!editor) return;
    const incoming = normaliseRichTextValue(value);
    if (incoming !== editor.getHTML() && incoming !== "<p></p>") {
      editor.commands.setContent(incoming, { emitUpdate: false });
    }
  }, [value, editor]);

  // Approximate min-height from the `rows` hint (1.5rem per row + padding)
  const minHeight = `${rows * 1.6 + 0.5}rem`;

  return (
    <div className="rounded-md border border-zinc-200 bg-white overflow-hidden focus-within:ring-2 focus-within:ring-zinc-200">
      {editor && <Toolbar editor={editor} />}
      <div style={{ minHeight }}>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
