import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Arbiter — Reasoning Engine",
  description: "Find the angle nobody else is looking at.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
