"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface Step {
  id: number;
  label: string;
}

interface StepperProps {
  steps: Step[];
  currentStep: number;
  className?: string;
}

export function Stepper({ steps, currentStep, className }: StepperProps) {
  return (
    <div className={cn("flex items-center gap-0", className)}>
      {steps.map((step, index) => {
        const isCompleted = step.id < currentStep;
        const isActive = step.id === currentStep;
        const isLast = index === steps.length - 1;

        return (
          <div key={step.id} className="flex items-center">
            <div className="flex flex-col items-center">
              <div
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full border-2 text-xs font-semibold transition-all duration-200",
                  isCompleted &&
                    "border-blue-600 bg-blue-600 text-white",
                  isActive &&
                    "border-blue-600 bg-white text-blue-600 shadow-sm shadow-blue-200",
                  !isCompleted &&
                    !isActive &&
                    "border-zinc-200 bg-zinc-50 text-zinc-400"
                )}
              >
                {isCompleted ? (
                  <Check className="h-4 w-4" />
                ) : (
                  step.id
                )}
              </div>
              <span
                className={cn(
                  "mt-1.5 text-xs font-medium whitespace-nowrap",
                  isActive && "text-blue-600",
                  isCompleted && "text-zinc-600",
                  !isCompleted && !isActive && "text-zinc-400"
                )}
              >
                {step.label}
              </span>
            </div>
            {!isLast && (
              <div
                className={cn(
                  "mx-2 mb-5 h-0.5 w-12 transition-all duration-200",
                  isCompleted ? "bg-blue-600" : "bg-zinc-200"
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
