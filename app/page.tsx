import { Suspense } from "react";
import { connection } from "next/server";
import HomeLoading from "@/components/HomeLoading";
import MeetPlanner from "@/components/MeetPlanner";
import { readScheduledCapability } from "@/lib/providers/config";

async function HomeContent() {
  await connection();
  // Read only the allow-listed capability; do not initialize or load the artifact for page render.
  return <MeetPlanner capability={readScheduledCapability()} />;
}

export default function Home() {
  return <Suspense fallback={<HomeLoading />}><HomeContent /></Suspense>;
}
