import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Recall Engine · Memory Lab",
  description: "A local demo for exploring agent memory across turns.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
