import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Buckit",
    short_name: "Buckit",
    description: "A shared space to record, understand, and plan spending.",
    start_url: "/workspace",
    display: "standalone",
    background_color: "#f8faf7",
    theme_color: "#173c2f",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  };
}
