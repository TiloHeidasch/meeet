import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import { Suspense } from "react";
import { messages, resolveLocaleFromHeader } from "@/lib/client/i18n";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

async function HtmlWithLocale({ children }: { children: React.ReactNode }) {
  const requestHeaders = await headers();
  const locale = resolveLocaleFromHeader(requestHeaders.get("accept-language"));
  return (
    <html
      lang={locale}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
      </body>
    </html>
  );
}

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const locale = resolveLocaleFromHeader(requestHeaders.get("accept-language"));
  return { title: messages[locale].shell.metadataTitle, description: messages[locale].shell.metadataDescription };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <Suspense fallback={<html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}><body className="min-h-full flex flex-col">{children}</body></html>}>
      <HtmlWithLocale>{children}</HtmlWithLocale>
    </Suspense>
  );
}
