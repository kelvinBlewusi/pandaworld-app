import ShaderBackground from "@/components/onboarding/ShaderBackground";

export default function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative min-h-screen bg-[#0a0a0c]">
      {/* Animated WebGL background */}
      <ShaderBackground />

      {/* Scrollable content layer */}
      <div className="relative z-10 flex min-h-screen items-start justify-center px-4 py-12">
        <div className="w-full max-w-3xl">
          {/* Glass card */}
          <div
            className="rounded-3xl border border-white/10 bg-black/40 p-8 shadow-2xl"
            style={{ backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)" }}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
