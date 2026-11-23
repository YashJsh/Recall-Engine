import type { Metadata } from "next";
import "./globals.css";
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

export const metadata: Metadata = {
  title: "Recall Engine · Memory Lab",
  description: "A local demo for exploring agent memory across turns.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={cn("font-sans", geist.variable)} suppressHydrationWarning>
      <head>
        {/* Follow the OS light/dark preference with shadcn's class-based dark theme. */}
        <script
          dangerouslySetInnerHTML={{
            __html: "(()=>{const m=matchMedia('(prefers-color-scheme: dark)');const a=()=>document.documentElement.classList.toggle('dark',m.matches);a();m.addEventListener('change',a)})()",
          }}
        />
      </head>
      <body className="bg-background text-foreground antialiased">
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
