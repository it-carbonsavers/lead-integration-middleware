import type { Metadata } from "next";
import { Outfit } from "next/font/google";
import "./globals.css";

// Carbon Savers typeface (self-hosted by Next at build time; no request to Google from the browser).
const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-outfit",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Carbon Savers · Lead Integration",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={outfit.variable}>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
