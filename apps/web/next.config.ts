import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["obsidian-headless"],
  transpilePackages: [
    "@delegate/obsidian-sync",
    "@delegate/domain",
    "@delegate/runtime",
    "@delegate/registry",
    "@delegate/web-data",
    "@delegate/web-ui",
  ],
};

export default nextConfig;
