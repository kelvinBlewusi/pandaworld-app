export default function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-zinc-50 to-blue-50/30">
      <div className="mx-auto max-w-3xl px-4 py-12">{children}</div>
    </div>
  );
}
