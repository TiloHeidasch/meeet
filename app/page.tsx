import { Suspense } from "react";
import { connection } from "next/server";
import MeetPlanner from "@/components/MeetPlanner";
import { readScheduledCapability } from "@/lib/providers/config";

async function HomeContent() {
  await connection();
  // Read only the allow-listed capability; do not initialize or load the artifact for page render.
  return <MeetPlanner capability={readScheduledCapability()} />;
}

function HomeLoading() {
  return <main className="grid min-h-screen place-items-center bg-[#f4f1eb] px-4 text-[#202522]"><div className="rounded-2xl border border-[#e4e2d9] bg-[#fffdf8] px-5 py-4 text-sm text-[#526057] shadow-[0_4px_16px_rgba(45,52,42,.04)]">Preparing your meeting map…</div></main>;
}

export default function Home() {
  return <Suspense fallback={<HomeLoading />}><HomeContent /></Suspense>;
}
