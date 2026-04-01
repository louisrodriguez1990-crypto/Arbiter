import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Prefer this repo as the app root when another package-lock exists higher up (e.g. C:\Users\Shadow\)
  outputFileTracingRoot: path.join(__dirname),
};

export default nextConfig;
