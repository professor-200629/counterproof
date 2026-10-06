import type { NextConfig } from "next";

/** FastAPI backend; the browser only ever calls same-origin /api/*. */
const BACKEND_URL = (process.env.BACKEND_URL ?? "http://127.0.0.1:8010").replace(/\/+$/, "");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${BACKEND_URL}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
