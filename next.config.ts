import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow large file uploads (OMs can be 50MB+)
  experimental: {
    proxyClientMaxBodySize: "100mb",
    serverActions: {
      bodySizeLimit: "100mb",
    },
  },

  // Python API will run separately; proxy in dev
  async rewrites() {
    return [
      {
        source: "/api/py/:path*",
        destination: "http://127.0.0.1:8000/:path*",
      },
    ];
  },
};

export default nextConfig;
