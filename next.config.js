/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Local-only dashboard. Bind to localhost so it never leaks.
  // Run with `npm run dev` and open http://localhost:3737
  // Required for the multi-stage Dockerfile — produces a minimal
  // .next/standalone folder that can be copied into a slim runtime image.
  output: "standalone",
};

module.exports = nextConfig;
