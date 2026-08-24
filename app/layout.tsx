import type { Metadata } from "next";
import { Lexend, Reem_Kufi_Fun, Source_Code_Pro } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { clerkConfigured, clerkPublishableKey } from "@/lib/clerk";
import "./globals.css";

// PRD 9.1 typography — the three faces the fest site already loads.
const lexend = Lexend({ subsets: ["latin"], weight: ["400", "500", "700"], variable: "--font-lexend" });
const reemKufi = Reem_Kufi_Fun({ subsets: ["latin"], weight: ["400", "700"], variable: "--font-reem-kufi" });
const sourceCodePro = Source_Code_Pro({ subsets: ["latin"], weight: ["400", "600"], variable: "--font-source-code-pro" });

export const metadata: Metadata = {
  title: "Yugaantar Finance & Operations",
  description: "Budget, reimbursements, vendors, income and work tickets for Yugaantar '26.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const shell = (
    <html lang="en" className={`${lexend.variable} ${reemKufi.variable} ${sourceCodePro.variable}`}>
      <body>{children}</body>
    </html>
  );

  // ClerkProvider throws without a publishable key, so it is only mounted once one
  // exists. Everything below it works identically under emailed sign-in links.
  //
  // The key is passed explicitly rather than left to `NEXT_PUBLIC_` inlining. That
  // inlining happens at *build* time, so a deployment that gained the variable after
  // its last build would have it at runtime, mount the provider, and then throw
  // "Missing publishableKey" on every page — including sign-in. This layout is a
  // server component, so it can read the live value and hand it down.
  return clerkConfigured()
    ? <ClerkProvider publishableKey={clerkPublishableKey()}>{shell}</ClerkProvider>
    : shell;
}
