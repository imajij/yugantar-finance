import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { clerkConfigured, clerkPublishableKey } from "@/lib/clerk";
import "./globals.css";

/*
 * One face, loaded variable.
 *
 * The fest site's Lexend and Reem Kufi were doing the opposite of the job here: a
 * display face on every heading makes a tool look like a poster, and a poster is
 * exactly what you do not want to read a hundred rows of at two in the morning.
 * Inter is the workhorse this interface actually needs — it was drawn for small
 * sizes on screens, and its intermediate weights are what let a heading read as a
 * heading at 15px without shouting.
 *
 * Mono is for the things that have to line up: amounts, UTRs, human ids.
 */
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  // Four weights and no more: body, the half-step that makes a row title read as
  // one, section headings, and page titles.
  weight: ["400", "500", "600"],
});
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-mono-face" });

export const metadata: Metadata = {
  title: "Yugaantar Finance & Operations",
  description: "Budget, reimbursements, vendors, income and work tickets for Yugaantar '26.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const shell = (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
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
