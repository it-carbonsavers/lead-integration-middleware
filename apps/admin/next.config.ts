import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const here = path.dirname(fileURLToPath(import.meta.url));
// Local admin API (Fastify). The browser only ever talks to this Next.js origin; requests to
// /admin-api/* are proxied server-side, so the session cookie is first-party and no CORS is needed.
const API_URL = process.env.ADMIN_API_URL ?? "http://localhost:3000";
const dev = process.env.NODE_ENV !== "production";

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  `connect-src 'self'${dev ? " ws:" : ""}`,
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
].join("; ");

const nextConfig: NextConfig = {
  turbopack: { root: path.join(here, "../..") },
  poweredByHeader: false,
  async redirects() {
    // Earlier page addresses, kept working after the navigation was simplified.
    return [
      { source: "/platforms", destination: "/sources", permanent: false },
      { source: "/agents", destination: "/reports", permanent: false },
      { source: "/recordings", destination: "/consent?tab=files", permanent: false },
      { source: "/submissions", destination: "/leads?tab=submissions", permanent: false },
      { source: "/destinations", destination: "/settings/destinations", permanent: false },
      { source: "/users", destination: "/settings/users", permanent: false },
      { source: "/audit", destination: "/settings/audit", permanent: false },
      { source: "/system", destination: "/settings", permanent: false },
    ];
  },
  async rewrites() {
    return [
      { source: "/admin-api/:path*", destination: `${API_URL}/admin/v1/:path*` },
      { source: "/openapi.json", destination: `${API_URL}/openapi.json` },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
