import { SignUp } from "@clerk/nextjs";
import { AuthSplitLayout } from "@/components/marketing/auth-split-layout";
import { CLERK_APPEARANCE } from "@/lib/constants/clerk-appearance";

export const metadata: import("next").Metadata = {
  title: "Sign up",
  description: "Create a free PandaWorld account and start drafting Jumia listings from WhatsApp or Chrome — AI fills in the title, description, and every attribute Jumia asks for.",
  // Same reasoning as /sign-in's metadata — see its own comment.
  robots: { index: false, follow: true },
};

export default function SignUpPage() {
  return (
    <AuthSplitLayout
      title="Create your account"
      subtitle="List on Jumia from WhatsApp or Chrome in minutes"
      image="/marketing/auth-lakeside.jpg"
      imageAlt="A lakeside campsite at golden hour, kayaks pulled up on the shore"
    >
      <SignUp appearance={CLERK_APPEARANCE} />
    </AuthSplitLayout>
  );
}
