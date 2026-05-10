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

      {/* Floating WhatsApp support button */}
      <a
        href="https://wa.me/qr/CTHJ6NQ2QOOAO1"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Chat with support on WhatsApp"
        className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-[#25D366] shadow-lg shadow-black/30 transition-transform duration-200 hover:scale-110 active:scale-95"
      >
        <svg viewBox="0 0 32 32" className="h-7 w-7 fill-white" xmlns="http://www.w3.org/2000/svg">
          <path d="M16.003 2C8.28 2 2 8.28 2 16.003c0 2.47.65 4.87 1.88 6.99L2 30l7.22-1.85A13.94 13.94 0 0 0 16.003 30C23.72 30 30 23.72 30 16.003 30 8.28 23.72 2 16.003 2zm0 25.47a11.52 11.52 0 0 1-5.88-1.61l-.42-.25-4.28 1.1 1.13-4.14-.27-.43A11.47 11.47 0 0 1 4.53 16c0-6.33 5.15-11.47 11.47-11.47S27.47 9.67 27.47 16 22.33 27.47 16.003 27.47zm6.3-8.6c-.35-.17-2.05-1.01-2.37-1.13-.31-.11-.54-.17-.77.17-.23.35-.88 1.13-1.08 1.36-.2.23-.4.25-.75.08-.35-.17-1.48-.55-2.82-1.74-1.04-.93-1.74-2.08-1.95-2.43-.2-.35-.02-.54.15-.71.16-.16.35-.4.52-.6.17-.2.23-.35.35-.58.11-.23.06-.44-.03-.61-.08-.17-.77-1.86-1.06-2.54-.28-.67-.56-.58-.77-.59h-.66c-.23 0-.6.08-.91.4-.31.31-1.19 1.16-1.19 2.83s1.22 3.28 1.39 3.51c.17.23 2.4 3.67 5.82 5.14.81.35 1.44.56 1.94.72.81.26 1.55.22 2.13.13.65-.1 2.01-.82 2.29-1.61.28-.8.28-1.48.2-1.62-.08-.14-.3-.22-.66-.39z"/>
        </svg>
      </a>
    </div>
  );
}
