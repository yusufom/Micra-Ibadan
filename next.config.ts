import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A stray lockfile in a parent directory would otherwise confuse root detection.
  turbopack: { root: __dirname },
};

export default nextConfig;
