import type { NextConfig } from "next";
import { resolve } from "node:path";

const nextConfig: NextConfig = {
  agentRules: false,
  serverExternalPackages: [
    "recall-engine",
    "fastembed",
    "@anush008/tokenizers",
    "@anush008/tokenizers-darwin-universal",
  ],
  turbopack: {
    root: resolve(process.cwd(), "../.."),
  },
};

export default nextConfig;
