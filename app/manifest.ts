import type { MetadataRoute } from "next";

// Minimal brand manifest so installed-web-app surfaces pick up the pin-headed
// "M" mark instead of a generic icon. Distinct from the server-side
// meeet-routing-manifest.json artifact; this one is served at
// /manifest.webmanifest by the Next.js manifest file convention.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "meeet",
    short_name: "meeet",
    start_url: "/",
    display: "standalone",
    background_color: "#f3f0e9",
    theme_color: "#202522",
    icons: [
      { src: "/icon.png", sizes: "512x512", type: "image/png" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  };
}