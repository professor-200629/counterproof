import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { Providers } from "@/components/providers";
import { AppShell } from "@/components/shell/app-shell";
import { SNAPSHOT_MODE } from "@/lib/snapshot";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: SNAPSHOT_MODE ? "CounterProof (recorded snapshot)" : "CounterProof",
    template: SNAPSHOT_MODE ? "%s - CounterProof (recorded snapshot)" : "%s - CounterProof",
  },
  description:
    (SNAPSHOT_MODE ? "Read-only recorded snapshot: " : "") +
    "Put AI promises to the test: measurable promises about an AI purchasing agent, counterexamples replayed by a declared trusted evaluator, optional rewards settled on chain.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0b0d10" },
    { media: "(prefers-color-scheme: light)", color: "#f4f5f7" },
  ],
  colorScheme: "dark light",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable} antialiased`}>
      <body className="min-h-dvh bg-canvas font-sans text-fg">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
