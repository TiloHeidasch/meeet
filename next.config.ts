import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  output: "standalone",
  // Routing inputs, generated manifests, deployment evidence, and tests are
  // mounted or executed outside the Next runtime. Keep the dynamic server-only
  // loader from turning those deployment assets into route trace inputs.
  outputFileTracingExcludes: {
    "/*": [
      "./routing/**",
      "./scripts/**",
      "./docs/**",
      "./test/**",
      "./e2e/**",
      "./.slim/**",
      "./**/__pycache__/**",
      "./**/*.pyc",
      "./**/meeet-routing-manifest.json",
      "./**/deployment-attestation.json",
      "./**/manifest.sha256",
      "./**/runtime.env",
    ],
  },
};

export default nextConfig;
