"use client";

import { useState } from "react";
import { Sparkles, RefreshCw, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface AICopyBlockProps {
  label: string;
  content: string;
  onRegenerate?: () => void;
  className?: string;
  multiline?: boolean;
}

export function AICopyBlock({
  label,
  content,
  onRegenerate,
  className,
  multiline = false,
}: AICopyBlockProps) {
  const [copied, setCopied] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRegenerate = () => {
    setIsRegenerating(true);
    setTimeout(() => {
      setIsRegenerating(false);
      onRegenerate?.();
    }, 1200);
  };

  return (
    <div className={cn("rounded-xl border bg-gradient-to-br from-blue-50/50 to-purple-50/50 p-4", className)}>
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-blue-500" />
          <span className="text-xs font-medium text-zinc-500">{label}</span>
          <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-600">
            AI
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-zinc-400 hover:text-zinc-600"
            onClick={handleCopy}
          >
            {copied ? (
              <Check className="h-3 w-3 text-emerald-500" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </Button>
          {onRegenerate && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-zinc-400 hover:text-zinc-600"
              onClick={handleRegenerate}
              disabled={isRegenerating}
            >
              <RefreshCw
                className={cn("h-3 w-3", isRegenerating && "animate-spin")}
              />
            </Button>
          )}
        </div>
      </div>
      <p
        className={cn(
          "text-sm text-zinc-800 leading-relaxed",
          !multiline && "line-clamp-2"
        )}
      >
        {isRegenerating ? (
          <span className="inline-flex items-center gap-2 text-zinc-400">
            <span className="h-2 w-2 animate-pulse rounded-full bg-blue-400" />
            Regenerating with AI…
          </span>
        ) : (
          content
        )}
      </p>
    </div>
  );
}
