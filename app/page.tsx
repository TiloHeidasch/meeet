import MeetPlanner from "@/components/MeetPlanner";
import { FULL_ROUTING_PROVIDER_CAPABILITIES } from "@/lib/domain/providers";
import { readProviderConfig } from "@/lib/providers/config";
import { MVG_DIRECT_CAPABILITIES } from "@/lib/providers/mvg-direct";

export default function Home() {
  const providerConfig = readProviderConfig();
  const routingCapabilities = providerConfig.mode === "mvg-direct-transit"
    ? MVG_DIRECT_CAPABILITIES
    : FULL_ROUTING_PROVIDER_CAPABILITIES;

  // Allow-list only UI capability data. URLs, tokens, and provenance stay server-side.
  return <MeetPlanner capability={{ mode: providerConfig.mode, supportedModes: [...routingCapabilities.supportedModes] }} />;
}
