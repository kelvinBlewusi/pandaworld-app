import { SignIn } from "@clerk/nextjs";
import { AuthSplitLayout } from "@/components/marketing/auth-split-layout";
import { CLERK_APPEARANCE } from "@/lib/constants/clerk-appearance";

export const metadata: import("next").Metadata = {
  title: "Sign in",
  description: "Log in to your PandaWorld account to draft and push Jumia listings from WhatsApp or Chrome.",
  // A signed-out visitor never has anything user-specific to see here —
  // no reason for this exact URL to rank on its own, and it would only
  // ever compete with the marketing pages for the same "PandaWorld"
  // queries. robots.txt already blocks /dashboard etc.; this is the one
  // public-but-not-worth-indexing page that isn't behind auth.
  robots: { index: false, follow: true },
};

export default function SignInPage() {
  return (
    <AuthSplitLayout
      title="Welcome back"
      subtitle="Log in to your PandaWorld account"
      image="/marketing/auth-lakeside.jpg"
      imageAlt="A lakeside campsite at golden hour, kayaks pulled up on the shore"
    >
      <SignIn appearance={CLERK_APPEARANCE} />
    </AuthSplitLayout>
  );
}
