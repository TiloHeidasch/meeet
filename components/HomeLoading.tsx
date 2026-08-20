"use client";

import { messages, useLocale } from "@/lib/client/i18n";

export default function HomeLoading() {
  const locale = useLocale();
  return <main className="grid min-h-screen place-items-center bg-[#f4f1eb] px-4 text-[#202522]"><div className="rounded-2xl border border-[#e4e2d9] bg-[#fffdf8] px-5 py-4 text-sm text-[#526057] shadow-[0_4px_16px_rgba(45,52,42,.04)]">{messages[locale].shell.loadingMap}</div></main>;
}
