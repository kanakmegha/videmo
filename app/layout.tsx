import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DemoGen — Turn any website into a demo video",
  description:
    "Paste a URL. AI crawls the site, builds a plan, and records a cinematic demo video — automatically.",
  openGraph: {
    title: "DemoGen",
    description: "AI-powered product demo generator",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen flex flex-col">{children}</body>
    </html>
  );
}
