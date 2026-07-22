import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "OpenClaw Cron Dashboard",
  description: "Local-only monitor + rerun for OpenClaw cron jobs",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-bg text-gray-100">{children}</body>
    </html>
  );
}
