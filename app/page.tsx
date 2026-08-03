import { Suspense } from "react";
import { connection } from "next/server";
import MeetPlanner from "@/components/MeetPlanner";
import { FULL_ROUTING_PROVIDER_CAPABILITIES } from "@/lib/domain/providers";
import { createMeetingProviders } from "@/lib/providers/factory";
import { readProviderConfig } from "@/lib/providers/config";
import { MVG_DIRECT_CAPABILITIES } from "@/lib/providers/mvg-direct";

async function HomeContent() {
  await connection();
  const providerConfig = readProviderConfig();
  const meetingProviders = createMeetingProviders();
  const routingFoundation = meetingProviders.routingFoundation;
  const routingCapabilities = providerConfig.mode === "mvg-direct-transit"
    ? MVG_DIRECT_CAPABILITIES
    : FULL_ROUTING_PROVIDER_CAPABILITIES;

  // Allow-list only UI capability data. URLs, tokens, and provenance stay server-side.
  return <MeetPlanner capability={{
    mode: providerConfig.mode,
    supportedModes: routingFoundation ? [...routingFoundation.supportedModes] : [...routingCapabilities.supportedModes],
    ...(routingFoundation && {
      routingFoundation: {
        state: routingFoundation.state,
        calculationAvailable: routingFoundation.calculationAvailable,
        reason: routingFoundation.reason,
      },
    }),
  }} />;
}

function HomeLoading() {
  return <main className="grid min-h-screen place-items-center bg-[#f4f1eb] px-4 text-[#202522]"><div className="rounded-2xl border border-[#e4e2d9] bg-[#fffdf8] px-5 py-4 text-sm text-[#526057] shadow-[0_4px_16px_rgba(45,52,42,.04)]">Preparing your meeting map…</div></main>;
}

export default function Home() {
  return <Suspense fallback={<HomeLoading />}><HomeContent /></Suspense>;
}
