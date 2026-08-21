import type { Metadata } from "next";
import { Lexend, Reem_Kufi_Fun, Source_Code_Pro } from "next/font/google";
import "./globals.css";

// PRD 9.1 typography — the three faces the fest site already loads.
const lexend = Lexend({ subsets: ["latin"], weight: ["400", "500", "700"], variable: "--font-lexend" });
const reemKufi = Reem_Kufi_Fun({ subsets: ["latin"], weight: ["400", "700"], variable: "--font-reem-kufi" });
const sourceCodePro = Source_Code_Pro({ subsets: ["latin"], weight: ["400", "600"], variable: "--font-source-code-pro" });

export const metadata: Metadata = {
  title: "Yugaantar Finance & Operations",
  description: "Budget, reimbursements, vendors, income and work tickets for Yugaantar '26.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${lexend.variable} ${reemKufi.variable} ${sourceCodePro.variable}`}>
      <body>{children}</body>
    </html>
  );
}
