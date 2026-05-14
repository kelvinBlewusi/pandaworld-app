"use client";

/**
 * RichTextField — a Textarea wrapped in a decorative toolbar that mirrors
 * the Jumia Vendor Center look (Paragraph / Bold / Italic / Link / Lists /
 * Indent / Image / Quote / Table / Video / Undo / Redo).
 *
 * The toolbar buttons are visual-only — Jumia VC strips formatting on save
 * anyway, so behaviour is plain text behind the scenes. The wrapper exists
 * so the schema-driven form feels native to sellers who've used VC.
 */

import {
  Bold, Italic, Link as LinkIcon,
  List, ListOrdered,
  IndentDecrease, IndentIncrease,
  Image as ImageIcon, Quote,
  Table as TableIcon, Video,
  Undo2, Redo2, ChevronDown,
} from "lucide-react";
import { Textarea } from "@/components/ui/textarea";

interface RichTextFieldProps {
  value:        string;
  onChange:     (v: string) => void;
  placeholder?: string;
  rows?:        number;
  id?:          string;
}

export function RichTextField({
  value,
  onChange,
  placeholder,
  rows = 4,
  id,
}: RichTextFieldProps) {
  return (
    <div className="rounded-md border border-zinc-200 bg-white overflow-hidden">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-zinc-200 bg-zinc-50/50 px-2 py-1.5">
        <button
          type="button"
          tabIndex={-1}
          className="flex items-center gap-1 rounded border border-zinc-200 bg-white px-1.5 py-0.5 text-[11px] text-zinc-600 hover:bg-zinc-50"
        >
          Paragraph <ChevronDown className="h-3 w-3 text-zinc-400" />
        </button>
        {[
          { Icon: Bold,           title: "Bold" },
          { Icon: Italic,         title: "Italic" },
          { Icon: LinkIcon,       title: "Link" },
          { Icon: List,           title: "Bulleted list" },
          { Icon: ListOrdered,    title: "Numbered list" },
          { Icon: IndentDecrease, title: "Decrease indent" },
          { Icon: IndentIncrease, title: "Increase indent" },
          { Icon: ImageIcon,      title: "Image" },
          { Icon: Quote,          title: "Quote" },
          { Icon: TableIcon,      title: "Table" },
          { Icon: Video,          title: "Video" },
          { Icon: Undo2,          title: "Undo" },
          { Icon: Redo2,          title: "Redo" },
        ].map(({ Icon, title }) => (
          <button
            key={title}
            type="button"
            title={title}
            tabIndex={-1}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-200 hover:text-zinc-700"
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        ))}
      </div>
      <Textarea
        id={id}
        value={value}
        rows={rows}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="border-0 rounded-none focus-visible:ring-0 text-sm"
      />
    </div>
  );
}
