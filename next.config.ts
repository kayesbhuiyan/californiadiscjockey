import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  skipTrailingSlashRedirect: true,
  images: {
    formats: ["image/avif", "image/webp"],
    deviceSizes: [640, 750, 828, 1080, 1200, 1920],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
    minimumCacheTTL: 2592000,
  },
  // Only HTML/CSS/JS from html-site go into the serverless function.
  // Images/videos live in public/media and are served as static CDN files
  // so they do not inflate Vercel Functions Storage.
  outputFileTracingIncludes: {
    "/[[...path]]": [
      "./html-site/**/*.html",
      "./html-site/**/*.css",
      "./html-site/**/*.js",
      "./html-site/**/*.mjs",
      "./html-site/**/*.json",
      "./html-site/**/*.svg",
      "./html-site/**/*.woff",
      "./html-site/**/*.woff2",
      "./html-site/**/*.ttf",
      "./html-site/**/*.eot",
      "./html-site/assets/**/*",
    ],
  },
  outputFileTracingExcludes: {
    "/*": ["./public/media/**/*", "./html-site/media/**/*", "./scripts/**/*", "./.git/**/*"],
    "/[[...path]]": ["./public/media/**/*", "./html-site/media/**/*"],
  },
};

export default nextConfig;
