/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Local-only dashboard. Bind to localhost so it never leaks.
  // Run with `npm run dev` and open http://localhost:3737
};

module.exports = nextConfig;
