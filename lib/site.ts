import fs from "fs";
import path from "path";

export const SITE_ORIGIN = "https://californiadiscjockey.com";

const SITE_ROOT = path.join(process.cwd(), "html-site");
const STATIC_PREFIXES = ["/wp-content/", "/wp-includes/", "/wp-admin/", "/wp-json/"];

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".map": "application/json; charset=utf-8",
};

type PageRecord = {
  file: string;
  inSitemap: boolean;
  forceNoindex: boolean;
  lastmod?: string;
};

type Catalog = {
  pages: Map<string, PageRecord>;
  files: Map<string, string>;
  sitemap: { path: string; lastmod?: string }[];
};

export type Resolved =
  | { type: "page"; file: string; canonicalPath: string; forceNoindex: boolean }
  | { type: "asset"; file: string }
  | { type: "redirect"; to: string }
  | { type: "sitemap" }
  | { type: "robots" };

let catalog: Catalog | null = null;

function isInsideRoot(file: string) {
  const root = path.resolve(SITE_ROOT);
  const resolved = path.resolve(file);
  return resolved === root || resolved.startsWith(root + path.sep);
}

function httrackAlias(filename: string) {
  const match = filename.match(/^(.*)([0-9a-f]{4})(\.[A-Za-z0-9]+)$/);
  if (!match || !/[a-f]/.test(match[2])) return null;
  return match[1] + match[3];
}

function decodePath(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isStaticPath(pathname: string) {
  return STATIC_PREFIXES.some((prefix) => pathname === prefix.slice(0, -1) || pathname.startsWith(prefix));
}

function buildCatalog(): Catalog {
  const pages = new Map<string, PageRecord>();
  const files = new Map<string, string>();
  const aliasGroups = new Map<string, string[]>();
  const sitemap: { path: string; lastmod?: string }[] = [];

  function walk(directory: string) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!isInsideRoot(full)) continue;

      const rel = path.relative(SITE_ROOT, full).split(path.sep).join("/");
      const urlPath = "/" + rel;
      files.set(urlPath.toLowerCase(), full);

      if (entry.name === "index.html") {
        const canonicalPath = urlPath.slice(0, -"index.html".length);
        const head = fs.readFileSync(full, "utf8").slice(0, 20000);
        const forceNoindex =
          /<title>\s*Page not found/i.test(head) ||
          canonicalPath.startsWith("/wp-admin/") ||
          canonicalPath.startsWith("/wp-login");
        const segments = canonicalPath.split("/").filter(Boolean);
        const inSitemap =
          !forceNoindex &&
          !segments.includes("feed") &&
          !canonicalPath.startsWith("/wp-json") &&
          !canonicalPath.startsWith("/wp-content") &&
          !canonicalPath.startsWith("/wp-includes") &&
          !canonicalPath.startsWith("/wp-admin") &&
          !canonicalPath.startsWith("/comments");
        const modified = head.match(
          /property=(["'])article:modified_time\1\s+content=(["'])([^"']+)\2/i,
        )?.[3];
        const record = { file: full, inSitemap, forceNoindex, lastmod: modified };
        pages.set(canonicalPath.toLowerCase(), record);
        if (inSitemap) sitemap.push({ path: canonicalPath, lastmod: modified });
        continue;
      }

      const alias = httrackAlias(entry.name);
      if (!alias) continue;
      const aliasPath = (path.posix.dirname(urlPath) + "/" + alias).replace(/\/{2,}/g, "/");
      const key = aliasPath.toLowerCase();
      const group = aliasGroups.get(key) ?? [];
      group.push(full);
      aliasGroups.set(key, group);
    }
  }

  walk(SITE_ROOT);

  for (const [aliasPath, matches] of aliasGroups) {
    if (matches.length === 1 && !files.has(aliasPath)) {
      files.set(aliasPath, matches[0]);
    }
  }

  sitemap.sort((a, b) => a.path.localeCompare(b.path));
  return { pages, files, sitemap };
}

function getCatalog() {
  if (!catalog) catalog = buildCatalog();
  return catalog;
}

function lookupFile(pathname: string) {
  const files = getCatalog().files;
  const key = pathname.toLowerCase();
  if (files.has(key)) return files.get(key) ?? null;
  if (key.endsWith(".jpeg")) return files.get(key.slice(0, -5) + ".jpg") ?? null;
  if (key.endsWith(".jpg")) return files.get(key.slice(0, -4) + ".jpeg") ?? null;
  return null;
}

function lookupPage(pathname: string) {
  const withSlash = pathname.endsWith("/") ? pathname : pathname + "/";
  return getCatalog().pages.get(withSlash.toLowerCase()) ?? null;
}

export function resolveRequest(pathname: string): Resolved | null {
  const decoded = decodePath(pathname);
  if (decoded.includes("\0") || decoded.split("/").includes("..")) return null;

  if (decoded === "/sitemap.xml") return { type: "sitemap" };
  if (decoded === "/robots.txt") return { type: "robots" };
  if (decoded === "/favicon.ico") {
    const icon = lookupFile("/wp-content/uploads/2022/09/918371-1.jpg");
    return icon ? { type: "asset", file: icon } : null;
  }

  if (decoded.endsWith("/index.html")) {
    const target = decoded.slice(0, -"index.html".length) || "/";
    return { type: "redirect", to: target };
  }

  const page = lookupPage(decoded);
  if (page) {
    const canonicalPath = decoded.endsWith("/") ? decoded : decoded + "/";
    if (decoded !== "/" && !decoded.endsWith("/")) {
      return { type: "redirect", to: canonicalPath };
    }
    return {
      type: "page",
      file: page.file,
      canonicalPath,
      forceNoindex: page.forceNoindex,
    };
  }

  const exact = lookupFile(decoded);
  if (exact) return { type: "asset", file: exact };

  if (decoded.endsWith("/")) {
    const trimmed = lookupFile(decoded.slice(0, -1));
    if (trimmed) return { type: "redirect", to: decoded.slice(0, -1) };
  }

  return null;
}

export function renderSitemap() {
  const urls = getCatalog().sitemap
    .map((entry) => {
      const loc = `${SITE_ORIGIN}${entry.path}`;
      const lastmod = entry.lastmod ? `\n    <lastmod>${entry.lastmod}</lastmod>` : "";
      return `  <url>\n    <loc>${loc}</loc>${lastmod}\n  </url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function renderRobots() {
  return `User-agent: *\nAllow: /\nDisallow: /wp-admin/\nDisallow: /wp-json/\nDisallow: /wp-login\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`;
}

export function contentTypeFor(file: string, bodyStart = "") {
  const extension = path.extname(file).toLowerCase();
  if (CONTENT_TYPES[extension]) {
    if (extension === ".html" && /<rss[\s>]|<feed[\s>]/i.test(bodyStart)) {
      return "application/rss+xml; charset=utf-8";
    }
    return CONTENT_TYPES[extension];
  }
  const start = bodyStart.trimStart();
  if (start.startsWith("<rss") || start.startsWith("<?xml")) return "application/xml; charset=utf-8";
  if (start.startsWith("{") || start.startsWith("[")) return "application/json; charset=utf-8";
  if (start.startsWith("<!DOCTYPE html") || start.startsWith("<html") || start.startsWith("<head")) {
    return "text/html; charset=utf-8";
  }
  return "application/octet-stream";
}

export function isTextAsset(file: string) {
  const extension = path.extname(file).toLowerCase();
  return extension === ".css" || extension === ".js" || extension === ".mjs" || extension === ".svg" || extension === ".map";
}

function rewriteUrl(raw: string, pageUrl: URL) {
  const trimmed = raw.trim().replace(/&amp;/g, "&");
  if (!trimmed || trimmed.startsWith("#") || /^(mailto:|tel:|sms:|javascript:|data:)/i.test(trimmed)) {
    return raw;
  }

  let absolute: URL;
  try {
    absolute = new URL(trimmed, pageUrl);
  } catch {
    return raw;
  }

  const host = absolute.hostname.replace(/^www\./i, "");
  if (host && host !== "californiadiscjockey.com") return raw;

  let pathname = absolute.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    /* keep the encoded path */
  }

  const segments = pathname.split("/").filter(Boolean);
  const mirroredHost = segments[0] ?? "";
  if (
    segments.length > 1 &&
    /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(mirroredHost) &&
    /\.[a-z]{2,}$/i.test(mirroredHost)
  ) {
    return `https://${segments.join("/")}${absolute.search}${absolute.hash}`;
  }

  if (pathname.endsWith("/index.html")) {
    pathname = pathname.slice(0, -"index.html".length) || "/";
  } else if (!isStaticPath(pathname) && !path.posix.extname(pathname) && !pathname.endsWith("/")) {
    pathname += "/";
  }

  return pathname + absolute.hash;
}

function localAssetExists(url: string) {
  if (!url.startsWith("/")) return true;
  return Boolean(lookupFile(url.split("#")[0]));
}

function rewriteSrcset(value: string, pageUrl: URL) {
  return value
    .split(",")
    .map((part) => {
      const bits = part.trim().split(/\s+/);
      if (!bits[0]) return "";
      bits[0] = rewriteUrl(bits[0], pageUrl);
      return localAssetExists(bits[0]) ? bits.join(" ") : "";
    })
    .filter(Boolean)
    .join(", ");
}

function readAttr(tag: string, name: string) {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"));
  return match?.[2];
}

function setAttr(tag: string, name: string, value: string) {
  const pattern = new RegExp(`(\\s${name}\\s*=\\s*)(["'])[\\s\\S]*?\\2`, "i");
  if (pattern.test(tag)) {
    return tag.replace(pattern, `$1"${value.replace(/"/g, "&quot;")}"`);
  }
  return tag.replace(/\/?>$/, ` ${name}="${value.replace(/"/g, "&quot;")}"$&`);
}

function protectSeoBlocks(html: string) {
  const blocks: string[] = [];
  const protectedHtml = html.replace(
    /<script\b[^>]*type=(["'])application\/ld\+json\1[^>]*>[\s\S]*?<\/script>/gi,
    (block) => {
      const token = `%%SEO_BLOCK_${blocks.length}%%`;
      blocks.push(block);
      return token;
    },
  );
  return { html: protectedHtml, blocks };
}

function restoreSeoBlocks(html: string, blocks: string[]) {
  return html.replace(/%%SEO_BLOCK_(\d+)%%/g, (_match, index: string) => blocks[Number(index)] ?? "");
}

function rewriteAbsoluteAssetUrls(html: string) {
  return html.replace(
    /https?:(?:\\\/\\\/|\/\/)(?:www\.)?californiadiscjockey\.com(?:\\\/|\/)(wp-(?:content|includes|admin|json)[^"'\s]*)/gi,
    (_match, asset: string) => "/" + asset.replace(/\\\//g, "/"),
  );
}

function absolutizeMetaImages(html: string) {
  return html.replace(
    /<meta\b[^>]*(?:property|name)=(["'])(?:og:image(?::secure_url)?|twitter:image(?::src)?)\1[^>]*>/gi,
    (tag) => {
      const content = readAttr(tag, "content");
      if (!content?.startsWith("/")) return tag;
      return setAttr(tag, "content", `${SITE_ORIGIN}${content}`);
    },
  );
}

function forceSeoUrls(html: string, canonical: string) {
  let next = html.replace(/<link\b[^>]*rel=(["'])canonical\1[^>]*>/gi, (tag) => setAttr(tag, "href", canonical));
  next = next.replace(/<meta\b[^>]*property=(["'])og:url\1[^>]*>/gi, (tag) => setAttr(tag, "content", canonical));
  next = next.replace(/<link\b[^>]*rel=(["'])shortlink\1[^>]*>/gi, (tag) => setAttr(tag, "href", canonical));
  if (!/rel=(["'])canonical\1/i.test(next)) {
    next = next.replace(/<head[^>]*>/i, `$&\n<link rel="canonical" href="${canonical}" />`);
  }
  return next;
}

function forceNoindex(html: string) {
  if (/<meta\b[^>]*name=(["'])robots\1[^>]*>/i.test(html)) {
    return html.replace(
      /<meta\b[^>]*name=(["'])robots\1[^>]*>/i,
      '<meta name="robots" content="noindex, follow" />',
    );
  }
  return html.replace(/<head[^>]*>/i, `$&\n<meta name="robots" content="noindex, follow" />`);
}

function revealLazyImages(html: string) {
  return html.replace(/<(img|iframe|source)\b[^>]*>/gi, (tag) => {
    const dataSrc = readAttr(tag, "data-src");
    const src = readAttr(tag, "src");
    if (dataSrc && (!src || src === "#" || src.startsWith("data:"))) {
      tag = setAttr(tag, "src", dataSrc);
    }
    const dataSrcset = readAttr(tag, "data-srcset");
    if (dataSrcset && !readAttr(tag, "srcset")) {
      tag = setAttr(tag, "srcset", dataSrcset);
    }
    return tag;
  });
}

export function rewriteHtml(html: string, canonicalPath: string, noindex: boolean) {
  const canonical = `${SITE_ORIGIN}${canonicalPath}`;
  const pageUrl = new URL(canonical);
  const protectedSeo = protectSeoBlocks(html);
  let next = protectedSeo.html;
  next = next.replace(/<!--\s*Mirrored from[\s\S]*?-->\s*/gi, "");
  next = next.replace(/<!--\s*Added by HTTrack\s*-->[\s\S]*?<!--\s*\/Added by HTTrack\s*-->\s*/gi, "");
  next = rewriteAbsoluteAssetUrls(next);

  next = next.replace(
    /(\s(?:href|src|action|poster|data-src|data-lazy-src|data-srcset|data-two_delay_src|data-bg|data-large_image|data-orig-file|xlink:href)\s*=\s*)(["'])([\s\S]*?)\2/gi,
    (_match, prefix: string, quote: string, value: string) => {
      const name = String(prefix).toLowerCase();
      const rewritten = name.includes("srcset") ? rewriteSrcset(value, pageUrl) : rewriteUrl(value, pageUrl);
      return `${prefix}${quote}${rewritten}${quote}`;
    },
  );

  next = next.replace(/(\ssrcset\s*=\s*)(["'])([\s\S]*?)\2/gi, (_match, prefix: string, quote: string, value: string) => {
    return `${prefix}${quote}${rewriteSrcset(value, pageUrl)}${quote}`;
  });

  next = next.replace(
    /(^|[^A-Za-z])url\(\s*(["']?)([^"')]+)\2\s*\)/gi,
    (match, prefix: string, quote: string, value: string) => {
      if (/^(data:|#)/i.test(value.trim())) return match;
      return `${prefix}url(${quote}${rewriteUrl(value, pageUrl)}${quote})`;
    },
  );

  next = revealLazyImages(next);
  next = forceSeoUrls(next, canonical);
  next = absolutizeMetaImages(next);
  if (noindex) next = forceNoindex(next);
  return restoreSeoBlocks(next, protectedSeo.blocks);
}

export function rewriteAssetText(source: string, assetUrl: string) {
  const pageUrl = new URL(assetUrl, SITE_ORIGIN);
  let next = rewriteAbsoluteAssetUrls(source);
  if (assetUrl.endsWith(".css") || assetUrl.endsWith(".svg")) {
    next = next.replace(
      /(^|[^A-Za-z])url\(\s*(["']?)([^"')]+)\2\s*\)/gi,
      (match, prefix: string, quote: string, value: string) => {
        if (/^(data:|#|https?:|\/\/)/i.test(value.trim())) {
          const rewritten = rewriteUrl(value, pageUrl);
          return rewritten === value ? match : `${prefix}url(${quote}${rewritten}${quote})`;
        }
        return match;
      },
    );
  }
  return next;
}

export function canonicalPathForFile(file: string) {
  const rel = "/" + path.relative(SITE_ROOT, file).split(path.sep).join("/");
  return rel;
}
