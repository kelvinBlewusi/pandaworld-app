// Mobile-first sizing, desktop back to compact.
//
// text-base (16px) below md is not a style choice: iOS Safari ZOOMS the
// whole page when a focused input's font is under 16px, and it does not
// zoom back out. A seller typing a price on their phone was left in a
// magnified viewport having to pinch out before they could reach the next
// field. Every input in this app inherits from here, so this one line
// decides it everywhere.
//
// h-11 (44px) is the tap-target floor Apple's HIG asks for. h-9 (36px)
// is comfortable with a mouse and fiddly with a thumb.
//
// Both revert at md so the desktop editor keeps its density.
import * as React from "react";
import { cn } from "@/lib/utils";

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-11 w-full rounded-lg border border-input bg-transparent px-3 py-1 text-base shadow-sm md:h-9 md:text-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";

export { Input };
