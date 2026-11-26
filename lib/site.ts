import fs from "fs";
import path from "path";
import { isOptimizedImagePath, isStaticPath, rewritePublicPath } from "@/lib/paths";
import { scrubCss, scrubHtmlFootprints } from "@/lib/scrub";
import imageSizes from "@/lib/image-sizes.json";

export const SITE_ORIGIN = "https://californiadiscjockey.com";
/** Bump when scrub/CSS output changes so immutable `/_css` URLs invalidate. */
export const CSS_BUNDLE_VERSION = "76";
/** Single site font — homepage title/nav face, applied everywhere. */
const SITE_FONT = '"Titillium Web",Arial,Helvetica,sans-serif';
const SITE_FONT_FACES = `@font-face{font-family:'Titillium Web';font-style:normal;font-weight:400;font-display:swap;src:url(/assets/fonts/titillium-web/NaPecZTIAOhVxoMyOr9n_E7fdMPmDQ.woff2) format('woff2')}@font-face{font-family:'Titillium Web';font-style:normal;font-weight:700;font-display:swap;src:url(/assets/fonts/titillium-web/NaPDcZTIAOhVxoMyOr9n_E7ffHjDGItzYw.woff2) format('woff2')}`;
const SITE_FONT_LOCK = `${SITE_FONT_FACES}:root{--text-font:${SITE_FONT}!important;--title-font:${SITE_FONT}!important;--navi-font:${SITE_FONT}!important;--widget-title-font:${SITE_FONT}!important}html,body,button,input,select,textarea,h1,h2,h3,h4,h5,h6,p,li,a,span,div,label,td,th,blockquote,.site-title,.brand-title,.page-title,.entry-title,.widget-title,.headline,.quote-text,.author,.cta-link,.reviews-word,.cdj-text,.cdj-frame-lite{font-family:${SITE_FONT}!important}`;
let homeCriticalCssCache: string | null | undefined;

const SITE_ROOT = path.join(process.cwd(), "html-site");
/** Static CDN files (images/videos). Kept out of the serverless function bundle. */
const PUBLIC_ROOT = path.join(process.cwd(), "public");
const IMAGE_SIZE_MAP = imageSizes as Record<string, { w: number; h: number }>;

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
  const resolved = path.resolve(file);
  const site = path.resolve(SITE_ROOT);
  const pub = path.resolve(PUBLIC_ROOT);
  return (
    resolved === site ||
    resolved.startsWith(site + path.sep) ||
    resolved === pub ||
    resolved.startsWith(pub + path.sep)
  );
}

function publicFile(pathname: string) {
  const clean = pathname.split("?")[0].split("#")[0];
  if (!clean.startsWith("/media/") && !clean.startsWith("/assets/")) return null;
  const candidates = [clean];
  // WordPress sized derivatives often aren't mirrored; fall back to the full image.
  const sized = clean.match(/^(.*)-\d+x\d+(\.[A-Za-z0-9]+)$/);
  if (sized) candidates.push(`${sized[1]}${sized[2]}`);
  if (/\.jpeg$/i.test(clean)) candidates.push(clean.replace(/\.jpeg$/i, ".jpg"));
  if (/\.jpg$/i.test(clean)) candidates.push(clean.replace(/\.jpg$/i, ".jpeg"));
  if (/\.webp$/i.test(clean)) {
    candidates.push(clean.replace(/\.webp$/i, ".jpg"), clean.replace(/\.webp$/i, ".png"));
  }
  for (const candidate of candidates) {
    const file = path.join(PUBLIC_ROOT, candidate.replace(/^\//, ""));
    if (isInsideRoot(file) && fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  return null;
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
        const segments = canonicalPath.split("/").filter(Boolean);
        const junkPath =
          segments.includes("embed") ||
          segments.includes("chrome-extension_") ||
          segments.some((s) => s.startsWith("$")) ||
          /\/(test|test-2|testimonil-page|bar-demon|bay-area-dj-old)\/$/i.test(canonicalPath);
        const forceNoindex =
          junkPath ||
          /<title>\s*Page not found/i.test(head) ||
          /<title>\s*Index of\s/i.test(head) ||
          /Page has moved/i.test(head) ||
          canonicalPath.startsWith("/wp-admin/") ||
          canonicalPath.startsWith("/wp-login");
        const inSitemap =
          !forceNoindex &&
          !segments.includes("feed") &&
          !canonicalPath.startsWith("/wp-json") &&
          !canonicalPath.startsWith("/wp-content") &&
          !canonicalPath.startsWith("/wp-includes") &&
          !canonicalPath.startsWith("/wp-admin") &&
          !canonicalPath.startsWith("/media/") &&
          !canonicalPath.startsWith("/assets/") &&
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
  const candidates = [pathname, rewritePublicPath(pathname)];
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (files.has(key)) return files.get(key) ?? null;
    if (key.endsWith(".jpeg") && files.has(key.slice(0, -5) + ".jpg")) return files.get(key.slice(0, -5) + ".jpg") ?? null;
    if (key.endsWith(".jpg") && files.has(key.slice(0, -4) + ".jpeg")) return files.get(key.slice(0, -4) + ".jpeg") ?? null;
    const fromPublic = publicFile(candidate);
    if (fromPublic) return fromPublic;
    if (candidate.toLowerCase().endsWith(".jpeg")) {
      const jpg = publicFile(candidate.slice(0, -5) + ".jpg");
      if (jpg) return jpg;
    }
    if (candidate.toLowerCase().endsWith(".jpg")) {
      const jpeg = publicFile(candidate.slice(0, -4) + ".jpeg");
      if (jpeg) return jpeg;
    }
  }
  return null;
}

function lookupPage(pathname: string) {
  const withSlash = pathname.endsWith("/") ? pathname : pathname + "/";
  return getCatalog().pages.get(withSlash.toLowerCase()) ?? null;
}

export function resolveRequest(pathname: string): Resolved | null {
  const decoded = decodePath(pathname);
  if (decoded.includes("\0") || decoded.split("/").includes("..")) return null;

  // WP keeps /bay-area-dj/ as a page URL but canonicalizes it to the homepage.
  if (/^\/bay-area-dj\/?$/i.test(decoded)) return { type: "redirect", to: "/" };

  if (decoded === "/sitemap.xml") return { type: "sitemap" };
  if (decoded === "/robots.txt") return { type: "robots" };
  if (decoded === "/favicon.ico") {
    // Prefer static public file (CDN) over streaming through the Node function.
    if (publicFile("/media/2022/09/918371-1.jpg")) {
      return { type: "redirect", to: "/media/2022/09/918371-1.jpg" };
    }
  }

  if (decoded.endsWith("/index.html")) {
    const target = decoded.slice(0, -"index.html".length) || "/";
    return { type: "redirect", to: target };
  }

  // HTTrack leaves both /events.html and /events/index.html; prefer the pretty page (with CSS).
  if (/\.html$/i.test(decoded) && !decoded.toLowerCase().endsWith("/index.html")) {
    const pretty = decoded.replace(/\.html$/i, "/");
    if (lookupPage(pretty)) return { type: "redirect", to: pretty };
  }

  // Duplicate HTTrack copies like /bay-area/foo/index-2.html → /bay-area/foo/
  if (/\/index-\d+\.html$/i.test(decoded)) {
    const pretty = decoded.replace(/\/index-\d+\.html$/i, "/");
    if (lookupPage(pretty)) return { type: "redirect", to: pretty };
  }

  const rewrittenPath = rewritePublicPath(decoded);
  if (rewrittenPath !== decoded && lookupFile(rewrittenPath)) {
    return { type: "redirect", to: rewrittenPath + (decoded.includes("?") ? "" : "") };
  }
  if (rewrittenPath !== decoded && !path.posix.extname(rewrittenPath)) {
    const asPage = lookupPage(rewrittenPath);
    if (asPage) return { type: "redirect", to: rewrittenPath.endsWith("/") ? rewrittenPath : rewrittenPath + "/" };
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

export function isVercelAppHost(host: string) {
  const hostname = host.split(":")[0].toLowerCase();
  return hostname === "vercel.app" || hostname.endsWith(".vercel.app");
}

export function renderRobots(options?: { blockIndexing?: boolean }) {
  if (options?.blockIndexing) {
    return `User-agent: *\nDisallow: /\n`;
  }
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

/** Map sister-site / Photon upload paths onto local /media when we host the file. */
function localMediaPathFromForeign(pathname: string) {
  let p = pathname;
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep encoded */
  }
  // Photon: /californiadiscjockey.com/wp-content/uploads/... or /californiadiscjockey.com/media/...
  const photon = p.match(
    /^\/(?:www\.)?californiadiscjockey\.com\/(?:wp-content\/uploads|media)\/(.+)$/i,
  );
  if (photon) return "/media/" + photon[1].split("?")[0];
  const uploads = p.match(/^\/(?:wp-content\/uploads|media)\/(.+)$/i);
  if (uploads) return "/media/" + uploads[1].split("?")[0];
  return null;
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

  const host = absolute.hostname.replace(/^www\./i, "").toLowerCase();
  // Legacy sister domain + Jetpack Photon still point at the same upload library.
  if (host === "djbayarea.com" || /\.wp\.com$/i.test(host)) {
    const local = localMediaPathFromForeign(absolute.pathname);
    if (local) return rewritePublicPath(local) + absolute.hash;
  }
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
    const mirrorHostNorm = mirroredHost.replace(/^www\./i, "").toLowerCase();
    // HTTrack often nests same-site assets as ../../www.californiadiscjockey.com/wp-content/...
    // Keep those on this site instead of emitting a dead absolute www URL.
    if (mirrorHostNorm === "californiadiscjockey.com") {
      pathname = "/" + segments.slice(1).join("/");
    } else if (mirrorHostNorm === "djbayarea.com" || /\.wp\.com$/i.test(mirrorHostNorm)) {
      // ../../djbayarea.com/wp-content/uploads/... or ../../i1.wp.com/californiadiscjockey.com/wp-content/...
      const afterHost = "/" + segments.slice(1).join("/");
      const mapped = localMediaPathFromForeign(afterHost);
      if (mapped) pathname = mapped;
      else return `https://${segments.join("/")}${absolute.search}${absolute.hash}`;
    } else {
      return `https://${segments.join("/")}${absolute.search}${absolute.hash}`;
    }
  }

  if (pathname.endsWith("/index.html")) {
    pathname = pathname.slice(0, -"index.html".length) || "/";
  } else if (/\/index-\d+\.html$/i.test(pathname)) {
    const pretty = pathname.replace(/\/index-\d+\.html$/i, "/");
    if (lookupPage(pretty)) pathname = pretty;
  } else if (/\.html$/i.test(pathname) && !pathname.toLowerCase().endsWith("/index.html")) {
    const pretty = pathname.replace(/\.html$/i, "/");
    if (lookupPage(pretty)) pathname = pretty;
  } else if (!isStaticPath(pathname) && !path.posix.extname(pathname) && !pathname.endsWith("/")) {
    pathname += "/";
  }

  pathname = rewritePublicPath(pathname);
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
  return html
    .replace(
      /https?:(?:\\\/\\\/|\/\/)(?:www\.)?californiadiscjockey\.com(?:\\\/|\/)(wp-(?:content|includes|admin|json)[^"'\s]*)/gi,
      (_match, asset: string) => rewritePublicPath("/" + asset.replace(/\\\//g, "/")),
    )
    .replace(/\/wp-content\/uploads\/elementor\//gi, "/assets/layout/")
    .replace(/\/wp-content\/uploads\//gi, "/media/")
    .replace(/\/wp-content\/themes\/tortuga\//gi, "/assets/site/")
    .replace(/\/wp-content\/plugins\/simple-image-slider\//gi, "/assets/slider/")
    .replace(/\/wp-content\/plugins\/dropdown-menu-widget\//gi, "/assets/nav/")
    .replace(/\/wp-content\/plugins\/contact-form-7\/includes\/css\//gi, "/assets/forms/")
    .replace(/\/wp-content\/plugins\/essential-addons-for-elementor-lite\/assets\/front-end\/css\/view\//gi, "/assets/addons/")
    .replace(/\/wp-content\/plugins\/elementor\/assets\/css\//gi, "/assets/layout/vendor/")
    .replace(/\/wp-content\/cache\/tw_optimize\/css\//gi, "/assets/critical/")
    .replace(/\/wp-content\/fonts\//gi, "/assets/fonts/");
}

function absolutizeMetaImages(html: string, pageUrl: URL) {
  return html.replace(
    /<meta\b[^>]*(?:property|name)=(["'])(?:og:image(?::secure_url)?|twitter:image(?::src)?)\1[^>]*>/gi,
    (tag) => {
      const content = readAttr(tag, "content");
      if (!content || /^(data:|#)/i.test(content)) return tag;
      // HTTrack left many og:image values as ../wp-content/uploads/... — resolve then absolutize.
      const rewritten = rewriteUrl(content, pageUrl);
      if (rewritten.startsWith("/")) return setAttr(tag, "content", `${SITE_ORIGIN}${rewritten}`);
      if (/^https?:\/\//i.test(rewritten)) return setAttr(tag, "content", rewritten);
      return tag;
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

function forceNoindex(html: string, directive = "noindex, follow") {
  const tag = `<meta name="robots" content="${directive}" />`;
  if (/<meta\b[^>]*name=(["'])robots\1[^>]*>/i.test(html)) {
    return html.replace(/<meta\b[^>]*name=(["'])robots\1[^>]*>/i, tag);
  }
  return html.replace(/<head[^>]*>/i, `$&\n${tag}`);
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

const IMAGE_WIDTHS = [640, 750, 828, 1080, 1200, 1920];
const cssBundleCache = new Map<string, string>();
const imageSizeCache = new Map<string, { w: number; h: number } | null>();

function resolveLocalAsset(file: string) {
  // On Windows, path.isAbsolute("/media/x") is true and becomes "F:\\media\\x".
  // Keep site asset URLs rooted under public/ (or an explicit Windows/UNC path).
  if (/^[A-Za-z]:[\\/]/.test(file) || file.startsWith("\\\\")) return file;
  if (file.startsWith("/media/") || file.startsWith("/assets/")) {
    return publicFile(file) || path.join(PUBLIC_ROOT, file.replace(/^\//, ""));
  }
  if (process.platform !== "win32" && path.isAbsolute(file)) return file;
  return file;
}

function imageSizeKey(file: string) {
  let key = file.split("?")[0].split("#")[0].replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(key)) {
    const idx = key.toLowerCase().indexOf("/media/");
    if (idx >= 0) key = key.slice(idx);
    const aidx = key.toLowerCase().indexOf("/assets/");
    if (aidx >= 0) key = key.slice(aidx);
  }
  if (!key.startsWith("/")) key = "/" + key;
  return key.toLowerCase();
}

function imageSize(file: string) {
  if (imageSizeCache.has(file)) return imageSizeCache.get(file) ?? null;
  const mapped = IMAGE_SIZE_MAP[imageSizeKey(file)];
  if (mapped) {
    imageSizeCache.set(file, mapped);
    return mapped;
  }
  let size: { w: number; h: number } | null = null;
  const resolved = resolveLocalAsset(file);
  if (!resolved || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    imageSizeCache.set(file, null);
    return null;
  }
  let fd: number;
  try {
    fd = fs.openSync(resolved, "r");
  } catch {
    imageSizeCache.set(file, null);
    return null;
  }
  try {
    const data = Buffer.alloc(524288);
    const bytes = fs.readSync(fd, data, 0, data.length, 0);
    const buf = data.subarray(0, bytes);
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf.length >= 24) {
      size = { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    } else if (buf[0] === 0x47 && buf[1] === 0x49 && buf.length >= 10) {
      size = { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    } else if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
      if (buf.toString("ascii", 12, 16) === "VP8X" && buf.length >= 30) {
        size = { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
      } else if (buf.toString("ascii", 12, 16) === "VP8 " && buf.length >= 30) {
        size = { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      }
    } else if (buf[0] === 0xff && buf[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < buf.length) {
        if (buf[offset] !== 0xff) break;
        const marker = buf[offset + 1];
        if (marker === 0xd8 || marker === 0xd9) {
          offset += 2;
          continue;
        }
        const length = buf.readUInt16BE(offset + 2);
        if (marker >= 0xc0 && marker <= 0xc3) {
          size = { h: buf.readUInt16BE(offset + 5), w: buf.readUInt16BE(offset + 7) };
          break;
        }
        offset += 2 + length;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  imageSizeCache.set(file, size);
  return size;
}

function removeAttr(tag: string, name: string) {
  return tag.replace(new RegExp(`\\s${name}\\s*=\\s*(["'])[\\s\\S]*?\\1`, "gi"), "");
}

/** Map same-origin absolute CSS/asset URLs to a site path; drop true externals. */
function localHrefPath(href: string) {
  const trimmed = href.trim();
  if (!trimmed || /^(data:|#)/i.test(trimmed)) return null;
  if (/^(https?:)?\/\//i.test(trimmed) || /^https?:/i.test(trimmed)) {
    try {
      const absolute = new URL(trimmed, SITE_ORIGIN);
      const host = absolute.hostname.replace(/^www\./i, "").toLowerCase();
      if (host !== "californiadiscjockey.com") return null;
      return absolute.pathname;
    } catch {
      return null;
    }
  }
  return trimmed.split("?")[0].split("#")[0] || null;
}

function resolveLegacyAssetPath(href: string, pageFile: string) {
  const clean = localHrefPath(href);
  if (!clean) return null;
  let pathname = clean;
  if (!pathname.startsWith("/")) {
    const resolved = path.resolve(path.dirname(pageFile), pathname);
    pathname = "/" + path.relative(SITE_ROOT, resolved).split(path.sep).join("/");
  }
  pathname = rewritePublicPath(pathname.replace(/\\/g, "/"));
  return lookupFile(pathname);
}

function shouldOmitStylesheet(publicHref: string) {
  // System/Titillium already cover first paint; skip heavy webfont CSS from the defer bundle.
  return /google-fonts|\/assets\/fonts\/|fonts\.googleapis|font-awesome/i.test(publicHref);
}

function shouldDeferStylesheet(_publicHref: string, _tag: string, media: string) {
  if (media === "print") return true;
  // Homepage strategy for every page: critical CSS + deferred sheets.
  // Extra layout reserves in #cdj-speed keep CLS near zero without render-blocking CSS.
  return true;
}

function homeCriticalCss() {
  if (homeCriticalCssCache !== undefined) return homeCriticalCssCache;
  const home = lookupPage("/");
  if (!home) {
    homeCriticalCssCache = null;
    return null;
  }
  const raw = fs.readFileSync(home.file, "utf8");
  const match = raw.match(/<style\b[^>]*class=(["'])two_critical_css\1[^>]*>([\s\S]*?)<\/style>/i);
  // Drop @font-face from critical CSS — fonts use font-display:optional and block FCP.
  homeCriticalCssCache = match
    ? minifyCss(unifySiteFontCss(match[2].replace(/@font-face\s*\{[^{}]*\}/gi, "")))
    : null;
  return homeCriticalCssCache;
}

function minifyCss(css: string) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([{};:,])\s*/g, "$1")
    .replace(/;}/g, "}")
    .trim();
}

/** Force homepage Titillium Web everywhere — drop Purista / Open Sans / Georgia stacks. */
function unifySiteFontCss(css: string) {
  return css
    .replace(/--text-font\s*:[^;!}]+/gi, `--text-font:${SITE_FONT}`)
    .replace(/--title-font\s*:[^;!}]+/gi, `--title-font:${SITE_FONT}`)
    .replace(/--navi-font\s*:[^;!}]+/gi, `--navi-font:${SITE_FONT}`)
    .replace(/--widget-title-font\s*:[^;!}]+/gi, `--widget-title-font:${SITE_FONT}`)
    .replace(
      /font-family\s*:\s*(?:'Purista'|"Purista"|Purista|'Open Sans'|"Open Sans"|Open Sans|Georgia(?:\s*,\s*'Times New Roman')?)[^;!}]*/gi,
      `font-family:${SITE_FONT}`,
    );
}

function localStylesheets(raw: string, pageFile: string) {
  const sheets: { href: string; file: string; defer: boolean }[] = [];
  for (const tag of raw.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = (readAttr(tag, "rel") || "").toLowerCase().split(/\s+/);
    if (!rel.includes("stylesheet")) continue;
    const href = readAttr(tag, "href");
    if (!href) continue;
    const file = resolveLegacyAssetPath(href, pageFile);
    if (!file || !isInsideRoot(file) || !fs.existsSync(file)) continue;
    const publicHref = canonicalPathForFile(file);
    if (shouldOmitStylesheet(publicHref)) continue;
    const media = (readAttr(tag, "media") || "all").toLowerCase();
    const defer = shouldDeferStylesheet(publicHref, tag, media);
    sheets.push({ href: publicHref, file, defer });
  }
  return sheets;
}

export function renderPageCss(pagePath: string, kind: "block" | "defer") {
  const normalized = pagePath.endsWith("/") ? pagePath : `${pagePath}/`;
  const key = `${normalized}|${kind}`;
  const cached = cssBundleCache.get(key);
  if (cached != null) return cached;
  const resolved = resolveRequest(normalized);
  if (!resolved || resolved.type !== "page") return null;
  const raw = fs.readFileSync(resolved.file, "utf8");
  const sheets = localStylesheets(raw, resolved.file).filter((sheet) => (kind === "defer" ? sheet.defer : !sheet.defer));
  if (!sheets.length) return "";
  const css = sheets
    .map((sheet) => rewriteAssetText(fs.readFileSync(sheet.file, "utf8"), sheet.href))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/font-display:\s*\w+/gi, "font-display:optional")
    .replace(/#20a0cf/gi, "#2278b0")
    .replace(/#ff6600/gi, "#e85d00")
    .replace(/\.banner\s+a\[href\^=["']tel:["']\]\s*\{([^}]*)\}/gi, (_full, body: string) => {
      return `.banner a[href^="tel:"]{${String(body).replace(/color\s*:\s*#[0-9a-f]+/gi, "color:#c00000")}}`;
    })
    .replace(
      /\.slider-wrap\s+\.slider-dot(\.slider-active|:hover)?\s*\{([^}]*)\}/gi,
      (_full, _state: string, body: string) => {
        const next = String(body)
          .replace(/width\s*:\s*\d+px/gi, "width:24px")
          .replace(/height\s*:\s*\d+px/gi, "height:24px")
          .replace(/-webkit-transform\s*:\s*scale\([^)]+\)/gi, "-webkit-transform:none")
          .replace(/transform\s*:\s*scale\([^)]+\)/gi, "transform:none");
        return `.slider-wrap .slider-dot${_state || ""}{${next}}`;
      },
    )
    .replace(/\.slider-wrap\s+\.slider-dots\s*\{([^}]*)\}/gi, (_full, body: string) => {
      return `.slider-wrap .slider-dots{${String(body).replace(/gap\s*:\s*\d+px/gi, "gap:12px")}}`;
    })
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (full, _quote: string, value: string) => {
      const clean = value.trim().split("?")[0];
      if (!clean.startsWith("/") || !/\.(?:woff2?|ttf|otf|eot)$/i.test(clean)) return full;
      return lookupFile(clean) ? full : "none";
    })
    .replace(/src:\s*none(?:\s+format\([^)]*\))?\s*,?/gi, "");
  // Defer bundle: drop @font-face entirely so font downloads can't contend with LCP.
  // Block / inline path keeps optional faces for pages that still reference them.
  const withFaces =
    kind === "defer"
      ? css.replace(/@font-face\s*\{[^{}]*\}/gi, "")
      : css.replace(/@font-face\s*\{[^{}]*\}/gi, (block) => {
          if (!/src\s*:/i.test(block)) return "";
          if (/font-display\s*:/i.test(block)) {
            return block.replace(/font-display:\s*[^;]+/gi, "font-display:optional");
          }
          return block.replace(/@font-face\s*\{/i, "@font-face{font-display:optional;");
        });
  const cleaned = minifyCss(unifySiteFontCss(scrubCss(withFaces)));
  cssBundleCache.set(key, cleaned);
  return cleaned;
}

function optimizedImage(src: string, widthAttr: string | undefined) {
  const pathOnly = src.split("?")[0].split("#")[0];
  if (!isOptimizedImagePath(pathOnly)) return null;
  if (/\.(svg|gif|ico)$/i.test(pathOnly)) return null;
  const file = lookupFile(pathOnly);
  // On Vercel, public/media is CDN-only (excluded from the function bundle), so
  // lookupFile/publicFile may miss. Still emit /_next/image URLs for /media paths.
  const publicUrl = (() => {
    if (file) {
      const abs = path.resolve(file);
      const pub = path.resolve(PUBLIC_ROOT);
      if (abs === pub || abs.startsWith(pub + path.sep)) {
        return "/" + path.relative(pub, abs).split(path.sep).join("/");
      }
    }
    if (pathOnly.startsWith("/media/") || pathOnly.startsWith("/wp-content/uploads/")) {
      return rewritePublicPath(pathOnly);
    }
    return null;
  })();
  if (!publicUrl) return null;
  // Prefer a committed next-gen sibling when present (keeps original PNG/JPG on disk).
  let serveUrl = publicUrl;
  let serveFile = file || publicUrl;
  if (/\.png$/i.test(publicUrl)) {
    const webp = publicUrl.replace(/\.png$/i, ".webp");
    if (IMAGE_SIZE_MAP[imageSizeKey(webp)] || publicFile(webp)) {
      serveUrl = webp;
      serveFile = publicFile(webp) || webp;
    }
  }
  const stated = Number(widthAttr);
  // Cap srcset to displayed sizes: small/medium content ≤1080; large size-full (~1200px) ≤1200.
  const maxCandidate =
    stated > 0 && stated <= 700 ? Math.max(stated * 2, 640) : stated > 1400 ? 1200 : 1080;
  const widths = IMAGE_WIDTHS.filter(
    (width) => width <= maxCandidate && (!stated || stated >= 400 || width <= stated * 2 + 40),
  );
  const chosen = widths.length ? widths : [640];
  const urlFor = (width: number) => `/_next/image?url=${encodeURIComponent(serveUrl)}&w=${width}&q=70`;
  const defaultSrcWidth = chosen.includes(828) ? 828 : chosen[Math.min(chosen.length - 1, 2)] ?? chosen[0];
  return {
    file: serveFile,
    src: urlFor(defaultSrcWidth),
    srcset: chosen.map((width) => `${urlFor(width)} ${width}w`).join(", "),
  };
}

function videoPoster(src: string) {
  // Playlist / channel-upload embeds use /embed/videoseries?list=... (no single video id).
  const playlist = src.match(/[?&]list=([A-Za-z0-9_-]+)/i)?.[1];
  if (playlist && /\/embed\/videoseries\b/i.test(src)) {
    // Known channel uploads playlist thumbnail (Bayareadj / sanfranciscoweddings).
    if (playlist === "UUnlcW8gakvxY8k_eTmyPDUQ") {
      return "https://i.ytimg.com/vi/FQJAaQ12VOk/mqdefault.jpg";
    }
    return "";
  }
  const youtube = src.match(
    /(?:youtube(?:-nocookie)?\.com\/(?:embed\/(?!videoseries\b)|shorts\/|watch\?v=)|youtu\.be\/)([A-Za-z0-9_-]{11})/i,
  );
  if (youtube) return `https://i.ytimg.com/vi/${youtube[1]}/mqdefault.jpg`;
  const vimeo = src.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (vimeo) return `https://vumbnail.com/${vimeo[1]}.jpg`;
  const instagram = src.match(/instagram\.com\/(?:reel|p|tv)\/([A-Za-z0-9_-]+)/i);
  if (instagram) {
    // Always use the CDN path. On Vercel, public/media is static-only and is not
    // present in the serverless filesystem, so lookupFile/publicFile would miss it.
    return `/media/instagram/${instagram[1]}.jpg`;
  }
  return "";
}

function dropScript(tag: string, body: string) {
  const id = readAttr(tag, "id") || "";
  const type = (readAttr(tag, "type") || "").toLowerCase();
  const src = `${readAttr(tag, "src") || ""} ${readAttr(tag, "data-two_delay_src") || ""}`;
  if (type.includes("ld+json")) return false;
  if (/simple-image-slider|\/assets\/slider\//i.test(`${id} ${src}`)) return false;
  if (type === "speculationrules" || id === "two_worker") return true;
  if (/data-two-no-delay|data-two_delay/.test(tag)) return true;
  if (/wp-emoji|wpemoji|emoji-settings/i.test(`${id}\n${src}\n${body}`)) return true;
  if (/^(jquery-core|jquery-migrate|dropdown-ie|svgxuse|jquery-flexslider|tortuga-slider|hoverIntent|wp-hooks|wp-i18n|swv|contact-form-7|flying-pages|tortuga-navigation|elementor-|eael-|jquery-ui)/i.test(id)) {
    return true;
  }
  if (/jquery|elementor|contact-form-7|flying-pages|wp-embed|hoverintent|essential-addons|\/eael/i.test(src)) return true;
  if (/elementor\/lazyload|lazyload\/observe|wp\.i18n|wp\.hooks/i.test(body)) return true;
  return false;
}

/**
 * Ensure page content uses a proper h1–h6 outline:
 * one content h1, no skipped levels, brand/widgets/forms at correct roles.
 */
function normalizePageHeadings(html: string): string {
  const blocks: string[] = [];
  let next = html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, (block) => {
    blocks.push(block);
    return `%%HEAD_BLK_${blocks.length - 1}%%`;
  });

  // Site name is branding, not the page title.
  next = next.replace(
    /<(h1)(\s[^>]*\b(?:brand-title|site-title)\b[^>]*)>([\s\S]*?)<\/h1>/gi,
    (_m, _tag: string, attrs: string, content: string) => `<p${attrs}>${content}</p>`,
  );

  // Drop empty headings (corporate page has blank h3s).
  next = next.replace(/<h([1-6])(\s[^>]*)?>\s*(?:&nbsp;|\u00a0|\s)*<\/h\1>/gi, "");

  // Comment form chrome — keep text, leave the content outline alone.
  next = next.replace(
    /<(h[1-6])(\s[^>]*\bcomment-reply-title\b[^>]*)>([\s\S]*?)<\/\1>/gi,
    (_m, _tag: string, attrs: string, content: string) => `<p${attrs}>${content}</p>`,
  );

  // Sidebar widget titles belong at h2 after the page h1 (not h3 / not <p>).
  next = next.replace(
    /<(?:h[1-6]|p)(\s[^>]*\b(?:panel-title|widget-title)\b[^>]*)>([\s\S]*?)<\/(?:h[1-6]|p)>/gi,
    (_m, attrs: string, content: string) => `<h2${attrs}>${content}</h2>`,
  );

  // Pages with only brand/listing titles need a real content h1 (before any h2+).
  if (!/<h1\b/i.test(next)) {
    const titleText =
      next
        .match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
        ?.replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/gi, " ")
        .replace(/&#8211;/g, "–")
        .replace(/&#8212;/g, "—")
        .replace(/\s+/g, " ")
        .split("|")[0]
        ?.trim() || "California Disc Jockey";
    const safe = titleText.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const h1 = `<h1 class="post-title">${safe}</h1>`;
    if (/\b(?:main-content|site-content)\b/i.test(next)) {
      next = next.replace(/(<(?:div|main)\b[^>]*\b(?:main-content|site-content)\b[^>]*>)/i, `$1${h1}`);
    } else if (/\b(?:main-column|site-main|content-area)\b/i.test(next)) {
      next = next.replace(
        /(<(?:div|main)\b[^>]*\b(?:main-column|site-main|content-area)\b[^>]*>)/i,
        `$1${h1}`,
      );
    } else if (/<h[1-6]\b/i.test(next)) {
      next = next.replace(/<h[1-6]\b/i, (tag) => `${h1}${tag}`);
    } else {
      next = next.replace(/<body\b[^>]*>/i, (body) => `${body}${h1}`);
    }
  }

  let lastLevel = 0;
  let sawH1 = false;
  next = next.replace(/<(h[1-6])(\s[^>]*)?>([\s\S]*?)<\/\1>/gi, (_full, tag: string, attrs = "", content: string) => {
    const className = String(attrs).match(/\bclass\s*=\s*(["'])([\s\S]*?)\1/i)?.[2] || "";
    if (/\b(?:panel-title|widget-title)\b/i.test(className)) {
      lastLevel = 2;
      return `<h2${attrs}>${content}</h2>`;
    }

    let level = Number(tag[1]);
    if (level === 1) {
      if (sawH1) level = lastLevel > 0 ? Math.min(lastLevel + 1, 2) : 2;
      else {
        sawH1 = true;
        lastLevel = 1;
        return `<h1${attrs}>${content}</h1>`;
      }
    }

    if (sawH1 && level > lastLevel + 1) level = lastLevel + 1;
    if (level < 1) level = 1;
    if (level > 6) level = 6;
    lastLevel = level;
    return `<h${level}${attrs}>${content}</h${level}>`;
  });

  next = next.replace(/%%HEAD_BLK_(\d+)%%/g, (_m, index: string) => blocks[Number(index)] ?? "");
  return next;
}

function optimizeHtml(html: string, canonicalPath: string) {
  let next = html.replace(/<style\b[^>]*id=(["'])global-styles-inline-css\1[^>]*>[\s\S]*?<\/style>/gi, "");
  // Noscript image duplicates steal LCP priority and bandwidth; real lazy imgs already exist.
  next = next.replace(/<noscript>\s*<img\b[\s\S]*?<\/noscript>/gi, "");
  // TinyMCE / HTTrack path bookmarks bloat corporate HTML (~14KB) and slow mobile parse.
  next = next.replace(
    /\s+data-(?:mce-(?:type|style|bogus)|path-to-node|index-in-node|mce-selected)=["'][^"']*["']/gi,
    "",
  );
  // Inline style= font stacks (Purista / Open Sans / Georgia) → Titillium Web.
  next = next.replace(/\sstyle=(["'])([\s\S]*?)\1/gi, (full, quote: string, style: string) => {
    if (!/font-family|Purista|Open Sans|Georgia/i.test(style)) return full;
    return ` style=${quote}${unifySiteFontCss(style)}${quote}`;
  });
  next = next.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (_full, attrs: string, body: string) => {
    let css = body
      .replace(/#20a0cf/gi, "#2278b0")
      .replace(/#ff6600/gi, "#e85d00")
      .replace(/(\.banner\s+a\[href\^=["']tel:["']\]\s*\{\s*color\s*:\s*)#ff0000/gi, "$1#c00000");
    const id = (/id=(["'])([^"']+)\1/i.exec(attrs)?.[2] || "").toLowerCase();
    const cls = (/class=(["'])([^"']+)\1/i.exec(attrs)?.[2] || "").toLowerCase();
    // Drop legacy multi-font faces — site-wide Titillium Web is injected via cdj-speed.
    if (id === "cdj-critical" || cls.includes("two_critical_css") || cls.includes("two_critical_font")) {
      css = css.replace(/@font-face\s*\{[^{}]*\}/gi, "");
    }
    css = minifyCss(unifySiteFontCss(css));
    if (!css) return "";
    // Keep inline CSS blocking so layout doesn't shift when deferred theme CSS arrives.
    return `<style${attrs}>${css}</style>`;
  });
  // Pages without Flying Pages critical CSS get the shared homepage critical sheet (prevents CLS).
  if (!/\btwo_critical_css\b/i.test(next)) {
    const critical = homeCriticalCss();
    if (critical) {
      next = next.replace(
        /<head[^>]*>/i,
        (head) => `${head}<style class="two_critical_css" id="cdj-critical">${critical}</style>`,
      );
    }
  }

  next = next.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (full, attrs: string, body: string) => {
    return dropScript(`<script ${attrs}>`, body) ? "" : full;
  });

  // Inline @font-face blocks (e.g. Purista in page <style>) must declare font-display.
  next = next.replace(/@font-face\s*\{[^{}]*\}/gi, (block) => {
    if (/font-display\s*:/i.test(block)) {
      return block.replace(/font-display:\s*[^;]+/gi, "font-display:optional");
    }
    return block.replace(/@font-face\s*\{/i, "@font-face{font-display:optional;");
  });

  next = next.replace(/<link\b[^>]*>/gi, (tag) => {
    const rel = (readAttr(tag, "rel") || "").toLowerCase();
    const href = readAttr(tag, "href") || "";
    const type = (readAttr(tag, "type") || "").toLowerCase();
    const localPath = localHrefPath(href) || "";
    const rewrittenLocal = localPath ? rewritePublicPath(localPath) : "";
    // RSS/Atom alternates are unused by visitors and bloat the HTML head.
    if (rel.includes("alternate") && (/rss|atom|xml/i.test(type) || /\/feed/i.test(href))) {
      return "";
    }
    if (
      rel.split(/\s+/).includes("stylesheet") &&
      (rewrittenLocal.startsWith("/wp-content/") ||
        rewrittenLocal.startsWith("/assets/") ||
        rewrittenLocal.startsWith("/media/") ||
        localPath.startsWith("/wp-content/") ||
        localPath.startsWith("/assets/") ||
        localPath.startsWith("/media/"))
    ) {
      return "";
    }
    if (/^https?:/i.test(href) && /font|roboto/i.test(href) && rel.includes("stylesheet")) {
      return tag.includes("onload=") ? tag : tag.replace(/>$/, ` media="print" onload="this.media='all'">`);
    }
    return tag;
  });

  const blockCss = renderPageCss(canonicalPath, "block");
  const deferCss = renderPageCss(canonicalPath, "defer");
  if (blockCss) {
    next = next.replace(
      /<head[^>]*>/i,
      (head) =>
        `${head}<link rel="stylesheet" href="/_css?p=${encodeURIComponent(canonicalPath)}&k=block&v=${CSS_BUNDLE_VERSION}">`,
    );
  }
  const deferHref = `/_css?p=${encodeURIComponent(canonicalPath)}&k=defer&v=${CSS_BUNDLE_VERSION}`;
  const bundleLinks = [
    `<link rel="preload" as="font" type="font/woff2" href="/assets/fonts/titillium-web/NaPecZTIAOhVxoMyOr9n_E7fdMPmDQ.woff2" crossorigin>`,
    `<link rel="preload" as="font" type="font/woff2" href="/assets/fonts/titillium-web/NaPDcZTIAOhVxoMyOr9n_E7ffHjDGItzYw.woff2" crossorigin>`,
    deferCss
      ? `<link rel="stylesheet" href="${deferHref}" media="print" onload="this.media='all'"><noscript><link rel="stylesheet" href="${deferHref}"></noscript>`
      : "",
    `<style id="cdj-speed">${SITE_FONT_LOCK}html{font-family:${SITE_FONT}}body{margin:0;background:#fff;color:#333;font-family:${SITE_FONT}}img{max-width:100%;height:auto;display:block}.elementor-invisible{visibility:visible!important}#page,.site-content,.main-content{min-height:60vh}.brand-header,.site-header{min-height:72px;position:relative;z-index:10000}@media (min-width:60.01em){.brand-header,.site-header{position:sticky;top:0}}.brand-header .site-nav-wrap,.site-header .site-nav-wrap{position:relative;z-index:10001}.nav-toggle{display:none}.nav-toggle .nav-toggle-text,.nav-toggle .menu-toggle-text{display:none}@media (max-width:59.99em){.nav-toggle{display:inline-flex;align-items:center;gap:.75em}.nav-toggle .nav-toggle-text,.nav-toggle .menu-toggle-text{display:inline-block;margin-left:.75em}}.post-body p{margin:0 0 1em}:root{--header-background-color:#069;--footer-background-color:#005782}.brand-header,.site-header,.site-nav-menu ul,.footer-panels,.footer-widgets-wrap{background:#069!important;background-color:#069!important}.footer-bar,.footer-wrap,#footer{background:#005782!important;background-color:#005782!important}.page-footer .footer-info,.page-footer .site-info,.page-footer a:link,.page-footer a:visited{color:#fff!important}.page-footer .footer-info,.page-footer .site-info,#footer-text{float:none;width:100%;text-align:center}.page-footer .credit-link{display:inline-block}.brand-title a:link,.brand-title a:visited,.site-title a:link,.site-title a:visited{color:#fff!important}.site-nav-menu a:link,.site-nav-menu a:visited{color:#fff!important}.sis-slider-wrapper,.slider-wrap{display:block;width:100%;max-width:100%;aspect-ratio:1920/481;overflow:hidden;background:#111;position:relative}.sis-slider-wrapper .sis-slider,.slider-wrap .slider{position:relative;width:100%;height:100%!important}.sis-slider-wrapper .sis-slide,.slider-wrap .slider-slide{height:100%!important}.sis-slider-wrapper.sis-fade .sis-slide.sis-active,.slider-wrap.slider-fade .slider-slide.slider-active{position:relative!important;inset:auto!important;height:100%!important;opacity:1!important}.sis-slider-wrapper .sis-slide img,.slider-wrap .slider-slide img,.sis-slider-wrapper img,.slider-wrap img{display:block!important;width:100%!important;height:100%!important;max-height:none!important;object-fit:cover!important;object-position:center center!important}.dj-card-image{aspect-ratio:16/9;overflow:hidden;background:#111}.dj-card-image img{width:100%;height:100%;object-fit:cover}.post-body img[width][height]{height:auto}@media (max-width:600px){.sis-slider-wrapper,.slider-wrap{aspect-ratio:16/9;height:auto!important;max-height:none!important}.sis-slider-wrapper .sis-slide img,.slider-wrap .slider-slide img,.sis-slider-wrapper img,.slider-wrap img{height:100%!important;max-height:none!important}.sis-slider-wrapper .sis-dots,.slider-wrap .slider-dots,.sis-slider-wrapper .slider-dots{bottom:10px!important;z-index:5}}@media (max-width:60em){.brand-header:has(.site-nav.toggled-on),.site-header:has(.site-nav.toggled-on),html.cdj-menu-open .brand-header,html.cdj-menu-open .site-header{max-height:100dvh;max-height:100vh;overflow-x:hidden;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}.site-nav.toggled-on,.site-nav.toggled-on>ul{max-height:none!important;overflow:visible!important}.site-nav .sub-menu.toggled-on,.site-nav ul ul.toggled-on{display:block!important}}.cdj-lite{display:block;position:relative;width:100%;max-width:100%;margin:0;padding:0;border:0;background:#111 !important;color:#fff !important;cursor:pointer;overflow:hidden;box-shadow:none !important;-webkit-tap-highlight-color:transparent;touch-action:manipulation;user-select:none}.cdj-lite img{position:absolute;left:0;top:50%;width:100%;height:auto;transform:translateY(-50%);z-index:0;pointer-events:none}.cdj-lite>.cdj-play{position:absolute;left:50%;top:50%;width:68px;height:48px;transform:translate(-50%,-50%);background:#f00;border-radius:14px;z-index:1;pointer-events:none}.cdj-lite>.cdj-play:before{content:"";position:absolute;left:27px;top:14px;border-style:solid;border-width:10px 0 10px 18px;border-color:transparent transparent transparent #fff}.cdj-lite--ig{background:linear-gradient(135deg,#833ab4 0%,#fd1d1d 48%,#fcb045 100%) !important}.cdj-lite--ig.cdj-lite--poster{background:#111 !important}.cdj-lite--ig.cdj-lite--poster img{object-fit:cover;height:100%;top:0;transform:none}.cdj-lite--ig .cdj-ig-face{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;z-index:0;color:#fff;pointer-events:none}.cdj-lite--ig .cdj-ig-face i{display:block;width:54px;height:54px;border:2px solid #fff;border-radius:14px;position:relative}.cdj-lite--ig .cdj-ig-face i:before{content:"";position:absolute;left:50%;top:50%;width:20px;height:20px;border:2px solid #fff;border-radius:50%;transform:translate(-50%,-50%)}.cdj-lite--ig .cdj-ig-face i:after{content:"";position:absolute;right:9px;top:9px;width:6px;height:6px;background:#fff;border-radius:50%}.cdj-lite--ig .cdj-ig-face em{font-style:normal;font-weight:700;letter-spacing:.03em;font-size:15px}#bay-area-dj-page .dj-instagram .dj-ig-crop:has(.cdj-lite){aspect-ratio:16/9!important;width:100%!important;max-width:100%!important;margin-left:0!important;margin-right:0!important;background:transparent!important}#bay-area-dj-page .dj-instagram .dj-ig-canvas:has(.cdj-lite){position:relative!important;inset:auto!important;width:100%!important;height:auto!important;transform:none!important}#bay-area-dj-page .dj-instagram .dj-ig-canvas .cdj-lite{width:100%;aspect-ratio:16/9}.post-body .banner a[href^="tel:"],.banner a[href^="tel:"]{color:#c00000!important}.post-body a,.post-body a.cta-link,a.cta-link,.comment-reply-title span,#reply-title span,.must-log-in a{color:#2278b0 !important}.must-log-in a{text-decoration:underline !important}span[style*="ff6600" i]{color:#e85d00 !important}span[style*="20a0cf" i]{color:#2278b0 !important}.slider-dots{gap:12px !important}.slider-dots .slider-dot,#page .slider-dots .slider-dot,.slider-wrap .slider-dots .slider-dot{width:24px !important;height:24px !important;min-width:24px !important;min-height:24px !important;padding:0 !important;transform:none !important}html.cdj-nav{cursor:progress}a.dj-button,.dj-container .dj-button,.dj-container a.dj-button{background:#e8c96a !important;color:#1a1a1a !important}a.dj-button:hover,.dj-container .dj-button:hover,.dj-container a.dj-button:hover{background:#d4af37 !important;color:#1a1a1a !important}.cdj-qa,.cdj-qa *{text-align:left !important}.cdj-qa ol{padding-left:1.4em;margin-left:0}.cdj-frame-lite{display:flex;align-items:center;justify-content:center;width:100%;max-width:100%;margin:0;padding:24px;border:0;background:#f3f6f8;color:#1a1a1a;font:600 16px/1.4 ${SITE_FONT};cursor:pointer}.cdj-frame-lite:hover{background:#e8eef2}.page-footer,.footer-widgets-wrap,.footer-panels,.footer-bar,#footer,.comment-respond,.dj-media,.dj-instagram,.dj-grid{content-visibility:auto;contain-intrinsic-size:800px}.slider-wrap .slider-slide{display:none}.slider-wrap .slider-slide.slider-active{display:block!important;opacity:1!important;position:relative!important;height:100%!important;inset:auto!important}.slider-wrap .slider-slide.slider-active img{opacity:1!important;visibility:visible!important}</style>`,
  ].join("");
  next = next.replace(/<\/head>/i, `${bundleLinks}</head>`);

  type LcpCand = { src: string; srcset: string; sizes: string; key: string };
  // Object bag so TypeScript still sees LcpCand | null after the replace() callback.
  const lcpCands: { slider: LcpCand | null; content: LcpCand | null } = { slider: null, content: null };
  let inSlider = false;
  let inMainContent = false;
  let postBodyAt = -1;
  let contentAt = -1;
  // Match pre-scrub class names — scrubHtmlFootprints runs after this pass.
  next = next.replace(
    /<article\b[^>]*>|<main\b[^>]*>|<div\b[^>]*\b(?:post-body|entry-content|sis-slider-wrapper|slider-wrap)\b[^>]*>|<img\b[^>]*>/gi,
    (tag, offset: number) => {
      if (/\b(?:sis-slider-wrapper|slider-wrap)\b/i.test(tag)) {
        inSlider = true;
        return tag;
      }
      if (/^<(?:article|main)\b/i.test(tag) || /\b(?:post-body|entry-content)\b/i.test(tag)) {
        inMainContent = true;
        inSlider = false;
        if (postBodyAt < 0 && /\b(?:post-body|entry-content)\b/i.test(tag)) postBodyAt = offset;
        return tag;
      }
      let src = readAttr(tag, "src") || "";
      if (!src || src.startsWith("data:") || src === "#") return tag;
      // Flaticon ships 512px icons; social rows display ~32px — request a tiny CDN size.
      if (/cdn-icons-png\.flaticon\.com\/512\//i.test(src)) {
        src = src.replace(/\/512\//i, "/64/");
        tag = setAttr(tag, "src", src);
      }
      const pathOnly = src.split("?")[0].split("#")[0];
      const optimized = optimizedImage(src, readAttr(tag, "width"));
      let updated = tag;
      if (optimized) {
        // Skip fat srcset on small/card images to keep HTML lean; keep it for heroes & large figures
        // so Best-Practices image-size-responsive still passes on desktop.
        updated = setAttr(removeAttr(removeAttr(updated, "srcset"), "src"), "src", optimized.src);
        const statedW = Number(readAttr(updated, "width") || readAttr(tag, "width") || 0);
        const needsSrcset = inSlider || statedW >= 700 || /size-full/i.test(tag);
        if (needsSrcset) {
          updated = setAttr(updated, "srcset", optimized.srcset);
          updated = setAttr(
            updated,
            "sizes",
            inSlider
              ? "100vw"
              : statedW >= 1000 || /size-full/i.test(tag)
                ? "(max-width: 1200px) 92vw, 1200px"
                : "(max-width: 840px) 92vw, 540px",
          );
        } else {
          updated = removeAttr(updated, "sizes");
        }
        updated = removeAttr(removeAttr(removeAttr(updated, "data-srcset"), "data-sizes"), "data-src");
      }
      if (!readAttr(updated, "width") || !readAttr(updated, "height")) {
        const size = imageSize(optimized?.file || pathOnly) || imageSize(pathOnly);
        if (size) {
          if (!readAttr(updated, "width")) updated = setAttr(updated, "width", String(size.w));
          if (!readAttr(updated, "height")) updated = setAttr(updated, "height", String(size.h));
        } else if (/cdn-icons-png\.flaticon\.com/i.test(pathOnly)) {
          // Tiny social icons — reserve space without a local size map entry.
          if (!readAttr(updated, "width")) updated = setAttr(updated, "width", "32");
          if (!readAttr(updated, "height")) updated = setAttr(updated, "height", "32");
        }
      }
      if (!readAttr(updated, "alt")) updated = setAttr(updated, "alt", "");
      const currentSrc = readAttr(updated, "src") || "";
      if (!currentSrc) {
        const fromSet = (readAttr(updated, "srcset") || "").split(",")[0]?.trim().split(/\s+/)[0];
        if (fromSet) updated = setAttr(updated, "src", fromSet);
      }
      updated = setAttr(updated, "decoding", "async");
      const width = Number(readAttr(updated, "width") || 0);
      const height = Number(readAttr(updated, "height") || 0);
      const tiny = (width > 0 && width < 120) || (height > 0 && height < 120);
      const chrome = /avatar|emoji|icon|logo|badge|sprite|gravatar|wp-smiley/i.test(`${src} ${updated}`);
      const cand: LcpCand = {
        src: readAttr(updated, "src") || src,
        srcset: readAttr(updated, "srcset") || "",
        sizes: readAttr(updated, "sizes") || "",
        key: readAttr(updated, "src") || src,
      };
      if (!tiny && !chrome && inSlider && !lcpCands.slider) lcpCands.slider = cand;
      if (!tiny && !chrome && inMainContent && !lcpCands.content) {
        lcpCands.content = cand;
        contentAt = offset;
      }
      updated = removeAttr(updated, "fetchpriority");
      updated = setAttr(updated, "loading", "lazy");
      return updated;
    },
  );

  // Hero slider is always above-fold when present — prefer it for LCP (mobile especially).
  // Picking a later content image left the visible slider `loading=lazy` and crushed Speed Index.
  const winner = lcpCands.slider || lcpCands.content;
  const winnerIsSlider = !!winner && winner === lcpCands.slider;
  const winnerSrc = winner?.src || "";
  const winnerKey = winner?.key || "";
  // Compact LCP bytes: slider defaults to 480w (mobile LCP); srcset covers desktop sharpness.
  const compactLcpSrc = (src: string, width: string) => {
    try {
      const u = new URL(src, "http://local.invalid");
      if (!u.pathname.includes("/_next/image")) return src;
      u.searchParams.set("w", width);
      u.searchParams.set("q", "60");
      return `${u.pathname}?${u.searchParams.toString()}`;
    } catch {
      return src;
    }
  };
  let lcpLinks = "";
  if (winnerSrc && winnerKey) {
    const wMobile = winnerIsSlider ? "480" : "750";
    const wDesktop = winnerIsSlider ? "640" : "1080";
    const compact = compactLcpSrc(winnerSrc, wMobile);
    const compactDesk = compactLcpSrc(winnerSrc, wDesktop);
    const sizes = winnerIsSlider ? "100vw" : "(max-width: 1200px) 92vw, 1080px";
    lcpLinks += `<link rel="preload" as="image" href="${compact}" imagesrcset="${compact} ${wMobile}w, ${compactDesk} ${wDesktop}w" imagesizes="${sizes}" fetchpriority="high">`;
    next = next.replace(/<img\b[^>]*>/gi, (tag) => {
      const src = readAttr(tag, "src") || "";
      if (src !== winnerKey && src !== winnerSrc) return tag;
      let updated = removeAttr(removeAttr(removeAttr(tag, "loading"), "fetchpriority"), "srcset");
      updated = setAttr(updated, "src", compact);
      updated = setAttr(updated, "srcset", `${compact} ${wMobile}w, ${compactDesk} ${wDesktop}w`);
      updated = setAttr(updated, "sizes", sizes);
      // sync decode cuts LCP render-delay on mobile when the image is already cached.
      updated = setAttr(updated, "decoding", "sync");
      return setAttr(setAttr(updated, "loading", "eager"), "fetchpriority", "high");
    });
  }
  // Keep only the LCP image eager+high — a second eager image steals mobile bandwidth from the hero.
  if (!winnerSrc) {
    // Absolute fallback: first substantial image in the document.
    let assigned = false;
    next = next.replace(/<img\b[^>]*>/gi, (tag) => {
      if (assigned) return tag;
      const src = readAttr(tag, "src") || "";
      if (!src || src.startsWith("data:") || src === "#") return tag;
      const width = Number(readAttr(tag, "width") || 0);
      const height = Number(readAttr(tag, "height") || 0);
      const tiny = (width > 0 && width < 120) || (height > 0 && height < 120);
      const chrome = /avatar|emoji|icon|logo|badge|sprite|gravatar|wp-smiley/i.test(`${src} ${tag}`);
      if (tiny || chrome) return tag;
      assigned = true;
      const compact = compactLcpSrc(src, "828");
      let updated = removeAttr(removeAttr(removeAttr(tag, "loading"), "fetchpriority"), "srcset");
      updated = setAttr(updated, "src", compact);
      updated = setAttr(updated, "sizes", "100vw");
      updated = setAttr(updated, "decoding", "sync");
      updated = setAttr(setAttr(updated, "loading", "eager"), "fetchpriority", "high");
      lcpLinks = `<link rel="preload" as="image" href="${compact}" fetchpriority="high">`;
      return updated;
    });
  }
  // Hoist LCP image preload early; keep font preloads (do not strip as="font").
  if (lcpLinks) {
    next = next.replace(/<link[^>]*rel=["']preload["'][^>]*>/gi, (tag) =>
      /\bas=["']font["']/i.test(tag) ? tag : "",
    );
    next = next.replace(/<head[^>]*>/i, (head) => `${head}${lcpLinks}`);
  }

  next = next.replace(/<video\b[^>]*>/gi, (tag) => {
    let updated = setAttr(tag, "preload", "none");
    const poster = readAttr(updated, "poster") || "";
    if (!poster || poster.startsWith("data:") || poster.startsWith("/_next/image")) return updated;
    const optimized = optimizedImage(poster, readAttr(updated, "width") || "720");
    if (optimized) updated = setAttr(updated, "poster", optimized.src);
    return updated;
  });

  next = next.replace(/<thead\b[^>]*>[\s\S]*?<\/thead>/gi, (thead) =>
    thead.replace(/<td\b/gi, "<th").replace(/<\/td>/gi, "</th>"),
  );
  next = next.replace(/<a\b([^>]*)>(\s*)More(\s*)<\/a>/gi, (full, attrs: string, before: string, after: string) => {
    const title = readAttr(`<a ${attrs}>`, "title");
    const label = title && !/^more$/i.test(title.trim()) ? title : "More details";
    return `<a ${attrs}>${before}${label}${after}</a>`;
  });

  // Fix bare email anchors (no href) and image-only links missing accessible names — keep visible content.
  next = next.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (full, attrs: string, inner: string) => {
    let tag = `<a ${attrs}>`;
    const href = readAttr(tag, "href");
    const text = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const email = text.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/i);
    if ((!href || href === "#" || /^javascript:/i.test(href)) && email) {
      tag = setAttr(tag, "href", `mailto:${email[0]}`);
      return `${tag}${inner}</a>`;
    }
    if (!href) {
      const className = readAttr(tag, "class");
      return `<span${className ? ` class="${className}"` : ""}>${inner}</span>`;
    }
    const aria = readAttr(tag, "aria-label");
    const title = readAttr(tag, "title");
    if (!text && !aria && !title) {
      const imgAlt = (inner.match(/<img\b[^>]*\salt=(["'])([\s\S]*?)\1/i) || [])[2]?.trim();
      const imgSrc = (inner.match(/<img\b[^>]*\ssrc=(["'])([\s\S]*?)\1/i) || [])[2] || "";
      const fromFile = imgSrc
        .split("/")
        .pop()
        ?.split("?")[0]
        ?.replace(/\.[a-z0-9]+$/i, "")
        .replace(/[-_]+/g, " ")
        .trim();
      const label = (imgAlt || fromFile || "View image").replace(/"/g, "&quot;");
      tag = setAttr(tag, "aria-label", label);
      return `${tag}${inner}</a>`;
    }
    return full;
  });

  // Drop noscript iframe fallbacks (including HTTrack/Flying Pages unclosed iframes).
  next = next.replace(/<noscript>\s*<iframe\b[\s\S]*?(?:<\/iframe>\s*)?<\/noscript>/gi, "");
  // Opening-tag-only: setAttr appends before the final ">", which breaks if the match includes </iframe>.
  next = next.replace(/<iframe\b[^>]*>/gi, (openTag) => {
    const rawSrc = readAttr(openTag, "src") || "";
    const dataSrc = readAttr(openTag, "data-src") || "";
    // Flying Pages / lazy embeds use src="#" with the real URL in data-src.
    const src =
      dataSrc && (!rawSrc || rawSrc === "#" || /^about:blank$/i.test(rawSrc) || rawSrc.startsWith("data:"))
        ? dataSrc
        : rawSrc || dataSrc;
    if (!/youtube\.com|youtu\.be|youtube-nocookie\.com|instagram\.com|vimeo\.com/i.test(src)) {
      // Contact form and other third-party frames: keep URL, defer load via lite facade in the full-tag pass.
      return openTag;
    }
    // Video embeds: rewrite the whole iframe element (open + close) in a second pass below.
    return openTag;
  });
  next = next.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, (tag) => {
    const open = tag.match(/^<iframe\b[^>]*>/i)?.[0] || tag;
    const rawSrc = readAttr(open, "src") || "";
    const dataSrc = readAttr(open, "data-src") || "";
    const src =
      dataSrc && (!rawSrc || rawSrc === "#" || /^about:blank$/i.test(rawSrc) || rawSrc.startsWith("data:"))
        ? dataSrc
        : rawSrc || dataSrc;
    if (!/youtube\.com|youtu\.be|youtube-nocookie\.com|instagram\.com|vimeo\.com/i.test(src)) {
      // Contact / third-party forms: click-to-load so the iframe document can't contend with LCP.
      if (/contact\.californiadiscjockey\.com/i.test(src) || /contact/i.test(src)) {
        const height = readAttr(open, "height") || "1500px";
        const title = (readAttr(open, "title") || "Contact form").replace(/"/g, "&quot;");
        const safeSrc = src.replace(/"/g, "&quot;");
        const safeHeight = String(height).replace(/"/g, "&quot;");
        return `<button type="button" class="cdj-frame-lite" data-src="${safeSrc}" data-height="${safeHeight}" data-title="${title}" aria-label="Load ${title}">Load contact form</button>`;
      }
      let updated = open;
      if (!readAttr(updated, "title") && !readAttr(updated, "aria-label")) {
        updated = setAttr(updated, "title", "Embedded content");
      }
      if (!/loading=/i.test(updated)) updated = setAttr(updated, "loading", "lazy");
      return tag.replace(/^<iframe\b[^>]*>/i, updated);
    }

    // Keep YouTube / Vimeo as real iframes so page content matches the WP site.
    // Instagram stays click-to-play (embed UX / LCP).
    const isInstagram = /instagram\.com/i.test(src);
    if (!isInstagram) {
      let updated = open;
      // Prefer data-src when present (lazy WP embeds).
      if (dataSrc && src === dataSrc) updated = setAttr(updated, "src", src);
      if (!readAttr(updated, "title") && !readAttr(updated, "aria-label")) {
        updated = setAttr(updated, "title", "YouTube video player");
      }
      if (!/loading=/i.test(updated)) updated = setAttr(updated, "loading", "lazy");
      if (!/allowfullscreen/i.test(updated)) updated = setAttr(updated, "allowfullscreen", "allowfullscreen");
      return tag.replace(/^<iframe\b[^>]*>/i, updated);
    }

    const title = (readAttr(open, "title") || "video").replace(/"/g, "&quot;");
    const withParam = (url: string, key: string, value: string) => {
      if (new RegExp(`[?&]${key}=`, "i").test(url)) {
        return url.replace(new RegExp(`([?&])${key}=[^&]*`, "i"), `$1${key}=${value}`);
      }
      return `${url}${url.includes("?") ? "&" : "?"}${key}=${value}`;
    };
    let playable = src;
    let mediaKind = "iframe";
    // Instagram's own embed "play" control is a link off-site. Prefer a local MP4
    // (public/media/instagram/{id}.mp4) so one click plays on this page.
    const igId = src.match(/instagram\.com\/(?:reel|p|tv)\/([A-Za-z0-9_-]+)/i)?.[1] || "";
    const localMp4 = igId ? `/media/instagram/${igId}.mp4` : "";
    if (localMp4) {
      playable = localMp4;
      mediaKind = "video";
    } else {
      playable = playable.replace(/\/embed\/?.*$/i, "/embed/");
      playable = withParam(playable, "autoplay", "1");
      playable = withParam(playable, "muted", "1");
    }
    const ratio = "16/9";
    const poster = videoPoster(src);
    const useDirectPoster = poster.startsWith("/media/");
    const optimized = !useDirectPoster && poster.startsWith("/media/") ? optimizedImage(poster, "840") : null;
    const imageSrc = useDirectPoster ? poster : optimized?.src || poster;
    const hasPosterImg = Boolean(poster);
    const image = hasPosterImg
      ? `<img src="${imageSrc}" alt="" width="480" height="360" loading="lazy" decoding="async" fetchpriority="low" referrerpolicy="no-referrer"${
          optimized?.srcset ? ` srcset="${optimized.srcset}" sizes="(max-width: 840px) 100vw, 840px"` : ""
        } onerror="this.onerror=null;this.src='${poster.replace(/'/g, "")}'">`
      : `<span class="cdj-ig-face" aria-hidden="true"><i></i><em>Instagram</em></span>`;
    const posterClass = hasPosterImg ? " cdj-lite--poster" : "";
    return `<button type="button" class="cdj-lite cdj-lite--ig${posterClass}" style="aspect-ratio:${ratio}" data-src="${playable.replace(/"/g, "&quot;")}" data-kind="${mediaKind}" data-title="${title}" data-ratio="${ratio}" aria-label="Play ${title}" onclick="return window.cdjPlay&&window.cdjPlay(this)">${image}<span class="cdj-play"></span></button>`;
  });

  // Keep activated IG embeds out of the old portrait crop/scale path in page scripts.
  next = next.replace(
    /if\s*\(\s*crop\.querySelector\(\s*(["'])\.cdj-lite\1\s*\)\s*\)/g,
    'if (crop.querySelector(".cdj-lite, .dj-ig-frame"))',
  );

  if (!next.includes('id="cdj-runtime"')) {
    next = next.replace(
      /<\/body>/i,
      `<style id="cdj-a11y">.post-body .banner a[href^="tel:"],.banner a[href^="tel:"]{color:#c00000!important}.post-body a,.post-body a.cta-link,a.cta-link,.comment-reply-title span,#reply-title span,.must-log-in a{color:#2278b0!important}.slider-wrap .slider-dots{gap:12px!important}.slider-wrap .slider-dot,.slider-wrap .slider-dot.slider-active,.slider-wrap .slider-dot:hover,#page .slider-dots .slider-dot{width:24px!important;height:24px!important;min-width:24px!important;min-height:24px!important;padding:0!important;transform:none!important;-webkit-transform:none!important}.dj-media-link{display:inline-flex!important;align-items:center!important;min-height:24px!important;padding:6px 0!important;line-height:1.4!important;position:relative!important;z-index:2!important}.dj-ig-crop:has(.cdj-lite--ig),.dj-ig-crop:has(.dj-ig-frame){display:block!important;width:100%!important;max-width:100%!important;margin:0!important;aspect-ratio:16/9!important;overflow:hidden!important;position:relative!important;height:auto!important;border-radius:0!important;box-shadow:none!important}.dj-ig-crop:has(.cdj-lite--ig) .dj-ig-canvas,.dj-ig-crop:has(.dj-ig-frame) .dj-ig-canvas{position:relative!important;inset:auto!important;display:block!important;width:100%!important;height:auto!important;transform:none!important}.dj-ig-crop .cdj-lite--ig,.dj-ig-crop .dj-ig-frame{position:relative!important;inset:auto!important;display:block!important;width:100%!important;height:auto!important;aspect-ratio:16/9!important;max-width:none!important;border:0!important;transform:none!important;background:#111!important;overflow:hidden!important}.dj-ig-crop .cdj-lite--ig img{position:absolute!important;inset:0!important;width:100%!important;height:100%!important;object-fit:cover!important}</style>
<script id="cdj-runtime">
const NAV_LINK="nav.site-nav a, nav.utility-nav a";
const pageCache=new Map();
let navToken=0;
function navUrl(link){
  const href=link.getAttribute("href");
  if(!href||href.charAt(0)==="#")return null;
  if(link.target&&link.target!=="_self")return null;
  if(link.hasAttribute("download"))return null;
  let url;
  try{url=new URL(href,location.href);}catch(e){return null;}
  if(url.origin!==location.origin)return null;
  return url;
}
function normalizeIgLite(){
  document.querySelectorAll(".dj-ig-crop").forEach((crop)=>{
    const frame=crop.querySelector(".cdj-lite--ig,.dj-ig-frame,iframe[src*='instagram.com'],video.cdj-local-video");
    if(!frame)return;
    const canvas=crop.querySelector(".dj-ig-canvas");
    // Full-width 16/9 like YouTube — kill old portrait/full-bleed crop math.
    crop.style.setProperty("width","100%","important");
    crop.style.setProperty("max-width","100%","important");
    crop.style.setProperty("margin-left","0px","important");
    crop.style.setProperty("margin-right","0px","important");
    crop.style.setProperty("aspect-ratio","16 / 9","important");
    crop.style.setProperty("height","auto","important");
    crop.style.setProperty("overflow","hidden","important");
    crop.style.setProperty("position","relative","important");
    if(canvas){
      canvas.style.setProperty("position","relative","important");
      canvas.style.setProperty("inset","auto","important");
      canvas.style.setProperty("width","100%","important");
      canvas.style.setProperty("height","auto","important");
      canvas.style.setProperty("transform","none","important");
      canvas.style.setProperty("transform-origin","initial","important");
    }
    frame.style.setProperty("position","relative","important");
    frame.style.setProperty("inset","auto","important");
    frame.style.setProperty("display","block","important");
    frame.style.setProperty("width","100%","important");
    frame.style.setProperty("height","auto","important");
    frame.style.setProperty("aspect-ratio","16 / 9","important");
    frame.style.setProperty("max-width","none","important");
    frame.style.setProperty("border","0","important");
    frame.style.setProperty("transform","none","important");
  });
}
normalizeIgLite();
setTimeout(normalizeIgLite,350);
setTimeout(normalizeIgLite,1250);
// Page script fitInstagram() re-applies old portrait crop math once .cdj-lite is gone.
// Wrap it so activated IG iframes stay visible/playable after the first click.
(function patchFitInstagram(){
  const apply=()=>{
    const orig=window.cdjFitInstagram;
    if(!orig||orig.__cdjPatched)return !!orig;
    function wrapped(){
      orig.apply(this,arguments);
      normalizeIgLite();
    }
    wrapped.__cdjPatched=true;
    window.cdjFitInstagram=wrapped;
    return true;
  };
  if(!apply()){
    const t=setInterval(()=>{if(apply())clearInterval(t);},100);
    setTimeout(()=>clearInterval(t),5000);
  }
})();
function loadPage(url){
  const key=url.pathname+url.search;
  if(pageCache.has(key))return pageCache.get(key);
  const job=fetch(key,{headers:{accept:"text/html"}}).then((res)=>{
    const type=res.headers.get("content-type")||"";
    if(!res.ok||type.indexOf("text/html")===-1)throw new Error("full");
    return res.text();
  });
  job.catch(()=>pageCache.delete(key));
  pageCache.set(key,job);
  if(pageCache.size>8)pageCache.delete(pageCache.keys().next().value);
  return job;
}
function runScripts(root){
  root.querySelectorAll("script").forEach((old)=>{
    if(old.id==="cdj-runtime"){old.remove();return;}
    if(old.src&&(old.src.indexOf("simple-image-slider")!==-1||old.src.indexOf("/assets/slider/")!==-1))delete window.__sliderLoaded;
    const script=document.createElement("script");
    for(const attr of old.attributes)script.setAttribute(attr.name,attr.value);
    if(!old.src)script.textContent=old.textContent;
    old.replaceWith(script);
  });
}
async function showPage(url,replace){
  const token=++navToken;
  document.documentElement.classList.add("cdj-nav");
  try{
    const html=await loadPage(url);
    if(token!==navToken)return;
    const doc=new DOMParser().parseFromString(html,"text/html");
    const title=doc.title;
    const block=doc.querySelector('link[rel="stylesheet"][href*="k=block"]');
    if(block){
      await new Promise((resolve)=>{
        const el=document.createElement("link");
        el.rel="stylesheet";
        el.href=block.getAttribute("href")||"";
        el.onload=resolve;
        el.onerror=resolve;
        document.head.appendChild(el);
      });
    }
    if(token!==navToken)return;
    document.head.replaceWith(doc.head);
    document.body.replaceWith(doc.body);
    document.title=title;
    runScripts(document.body);
    normalizeIgLite();
    const next=url.pathname+url.search+url.hash;
    if(replace)history.replaceState({cdj:1},"",next);
    else history.pushState({cdj:1},"",next);
    const hashTarget=url.hash?document.getElementById(decodeURIComponent(url.hash.slice(1))):null;
    if(hashTarget)hashTarget.scrollIntoView();
    else window.scrollTo(0,0);
  }catch(e){
    location.assign(url.href);
  }finally{
    if(token===navToken)document.documentElement.classList.remove("cdj-nav");
  }
}
document.addEventListener("pointerenter",(event)=>{
  const link=event.target instanceof Element&&event.target.closest(NAV_LINK);
  if(!link)return;
  const url=navUrl(link);
  if(url)loadPage(url).catch(()=>{});
},true);
document.addEventListener("focusin",(event)=>{
  const link=event.target instanceof Element&&event.target.closest(NAV_LINK);
  if(!link)return;
  const url=navUrl(link);
  if(url)loadPage(url).catch(()=>{});
});
window.addEventListener("popstate",()=>{showPage(new URL(location.href),true);});
function activateLite(lite){
  if(!lite||lite.dataset.cdjPlaying==="1")return false;
  lite.dataset.cdjPlaying="1";
  const src=lite.dataset.src||"";
  const crop=lite.closest(".dj-ig-crop");
  // Local MP4 (Instagram reels hosted under /media/instagram/) — real in-page play.
  // Avoid \\? in this TS template literal — it becomes a broken (?|$) regex in the browser.
  if(lite.dataset.kind==="video"||src.indexOf(".mp4")!==-1){
    const video=document.createElement("video");
    video.className="dj-ig-frame cdj-local-video";
    video.src=src;
    video.controls=true;
    video.autoplay=true;
    video.playsInline=true;
    video.setAttribute("playsinline","");
    video.setAttribute("webkit-playsinline","");
    video.preload="auto";
    video.title=lite.dataset.title||"Video";
    video.style.cssText="width:100%;aspect-ratio:16/9;display:block;background:#111;object-fit:contain;border:0";
    lite.replaceWith(video);
    const play=video.play();
    if(play&&typeof play.catch==="function")play.catch(()=>{});
    if(crop)normalizeIgLite();
    return false;
  }
  const frame=document.createElement("iframe");
  // Assign src in the same turn as the user gesture so autoplay is allowed.
  frame.setAttribute("src",src);
  frame.title=lite.dataset.title||"Video";
  frame.setAttribute("allow","accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share");
  frame.setAttribute("allowfullscreen","");
  frame.allowFullscreen=true;
  frame.referrerPolicy="strict-origin-when-cross-origin";
  frame.style.border="0";
  if(lite.classList.contains("cdj-frame-lite")){
    frame.style.width="100%";
    const h=lite.dataset.height||"1500px";
    frame.style.minHeight=h;
    frame.style.height=h;
  }else if(lite.classList.contains("cdj-lite--ig")){
    frame.scrolling="no";
    frame.className="dj-ig-frame fitvidsignore";
    frame.style.width="100%";
    frame.style.aspectRatio=lite.dataset.ratio||"16/9";
    frame.style.maxWidth="none";
    frame.style.transform="none";
  }else{
    frame.style.width="100%";
    frame.style.aspectRatio=lite.dataset.ratio||"16/9";
    frame.style.minHeight="200px";
  }
  lite.replaceWith(frame);
  if(crop){
    normalizeIgLite();
    if(typeof window.cdjFitInstagram==="function")window.cdjFitInstagram();
    normalizeIgLite();
  }
  return false;
}
window.cdjPlay=function(el){activateLite(el);return false;};
function onLitePointer(event){
  if(event.pointerType==="mouse"&&event.button!==0)return;
  const target=event.target;
  if(!(target instanceof Element))return;
  const lite=target.closest(".cdj-lite,.cdj-frame-lite");
  if(!lite||lite.dataset.cdjPlaying==="1")return;
  event.preventDefault();
  event.stopPropagation();
  activateLite(lite);
}
// pointerdown = first tap (most reliable one-click on mobile + desktop).
document.addEventListener("pointerdown",onLitePointer,true);
document.addEventListener("keydown",(event)=>{
  if(event.key!=="Enter"&&event.key!==" ")return;
  const target=event.target;
  if(!(target instanceof Element))return;
  const lite=target.closest(".cdj-lite,.cdj-frame-lite");
  if(!lite)return;
  event.preventDefault();
  activateLite(lite);
});
document.addEventListener("click",(event)=>{
  const target=event.target;
  if(!(target instanceof Element))return;
  const liteClick=target.closest(".cdj-lite,.cdj-frame-lite");
  if(liteClick){
    if(liteClick.dataset.cdjPlaying!=="1")activateLite(liteClick);
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  const toggle=target.closest(".nav-toggle");
  if(toggle){
    const wrap=toggle.closest(".site-nav-wrap,.header-bar,.brand-header,.site-header");
    const nav=wrap&&wrap.querySelector(".site-nav,.utility-nav");
    if(nav){
      const open=nav.classList.toggle("toggled-on");
      toggle.setAttribute("aria-expanded",open?"true":"false");
      document.documentElement.classList.toggle("cdj-menu-open",open);
      if(open){
        requestAnimationFrame(()=>{try{nav.scrollIntoView({block:"nearest"});}catch(e){}});
      }
    }
    return;
  }
  const dropBtn=target.closest(".dropdown-toggle");
  if(dropBtn&&window.matchMedia("(max-width: 60em)").matches){
    const li=dropBtn.closest(".nav-has-children,li");
    const sub=li&&li.querySelector(":scope > .sub-menu, :scope > ul");
    if(sub){
      event.preventDefault();
      event.stopPropagation();
      const open=sub.classList.toggle("toggled-on");
      dropBtn.classList.toggle("toggled-on",open);
      dropBtn.setAttribute("aria-expanded",open?"true":"false");
      return;
    }
  }
  const parentLink=target.closest(".nav-has-children > a");
  if(parentLink&&window.matchMedia("(max-width: 60em)").matches){
    const li=parentLink.parentElement;
    const sub=li&&li.querySelector(":scope > .sub-menu, :scope > ul");
    if(sub){
      event.preventDefault();
      const open=!sub.classList.contains("toggled-on");
      sub.classList.toggle("toggled-on",open);
      const btn=li.querySelector(":scope > .dropdown-toggle");
      if(btn){btn.classList.toggle("toggled-on",open);btn.setAttribute("aria-expanded",open?"true":"false");}
      return;
    }
  }
  if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
  const link=target.closest(NAV_LINK);
  if(!link)return;
  const url=navUrl(link);
  if(!url||(url.pathname===location.pathname&&url.search===location.search))return;
  event.preventDefault();
  showPage(url,false);
});
</script></body>`,
    );
  }

  next = next.replace(/<script\b[^>]*id=(["'])(?:simple-image-slider-js|site-slider-js)\1[^>]*>/gi, (tag) => {
    let src = readAttr(tag, "src") || readAttr(tag, "data-two_delay_src") || "";
    if (!src || src === "inline") return "";
    src = src.replace(/^https?:\/\/(?:www\.)?californiadiscjockey\.com/i, "");
    src = rewritePublicPath(src);
    let updated = setAttr(tag, "src", src);
    updated = setAttr(updated, "id", "site-slider-js");
    if (!/\sdefer(?:\s|=|>)/i.test(updated)) updated = updated.replace(/>$/, " defer>");
    return updated;
  });
  next = next.replace(
    /<span\s+class=(["'])credit-link\1>[\s\S]*?<\/span>/i,
    `<span class="credit-link">&copy; ${new Date().getFullYear()} California Disc Jockey. All rights reserved.</span>`,
  );
  next = next.replace(/WordPress Theme:\s*Tortuga by ThemeZee\.?/gi, "");
  next = scrubHtmlFootprints(next);
  next = normalizePageHeadings(next);
  return next;
}

export function rewriteHtml(
  html: string,
  canonicalPath: string,
  noindex: boolean,
  options?: { blockIndexing?: boolean },
) {
  const canonical = `${SITE_ORIGIN}${canonicalPath}`;
  const pageUrl = new URL(canonical);
  const protectedSeo = protectSeoBlocks(html);
  let next = protectedSeo.html;
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

  // Drop comments so commented-out legacy images (e.g. missing IMG_4247) are not revived.
  next = next.replace(/<!--[\s\S]*?-->/g, "");
  next = revealLazyImages(next);
  next = forceSeoUrls(next, canonical);
  next = absolutizeMetaImages(next, pageUrl);
  if (options?.blockIndexing) next = forceNoindex(next, "noindex, nofollow");
  else if (noindex) next = forceNoindex(next);
  next = optimizeHtml(next, canonicalPath);
  next = restoreSeoBlocks(next, protectedSeo.blocks);
  // JSON-LD and other protected blocks still carry legacy upload paths.
  next = next
    .replace(/https?:\\\/\\\/(?:www\.)?californiadiscjockey\.com\\\/wp-content\\\/uploads\\\/elementor\\\//gi, "https:\\/\\/californiadiscjockey.com\\/assets\\/layout\\/")
    .replace(/https?:\\\/\\\/(?:www\.)?californiadiscjockey\.com\\\/wp-content\\\/uploads\\\//gi, "https:\\/\\/californiadiscjockey.com\\/media\\/")
    .replace(/https?:\/\/(?:www\.)?californiadiscjockey\.com\/wp-content\/uploads\/elementor\//gi, "https://californiadiscjockey.com/assets/layout/")
    .replace(/https?:\/\/(?:www\.)?californiadiscjockey\.com\/wp-content\/uploads\//gi, "https://californiadiscjockey.com/media/")
    .replace(/https?:\\\/\\\/i\d+\.wp\.com\\\/(?:www\.)?californiadiscjockey\.com\\\/(?:wp-content\\\/uploads|media)\\\//gi, "https:\\/\\/californiadiscjockey.com\\/media\\/")
    .replace(/https?:\/\/i\d+\.wp\.com\/(?:www\.)?californiadiscjockey\.com\/(?:wp-content\/uploads|media)\//gi, "https://californiadiscjockey.com/media/")
    .replace(/https?:\/\/(?:www\.)?djbayarea\.com\/(?:wp-content\/uploads|media)\//gi, "https://californiadiscjockey.com/media/")
    .replace(/\/wp-content\/uploads\/elementor\//gi, "/assets/layout/")
    .replace(/\/wp-content\/uploads\//gi, "/media/")
    .replace(/\sclass=(["'])yoast-schema-graph\1/gi, ' class="schema-graph"')
    .replace(/<!--\s*\/?wp:[\s\S]*?-->/gi, "")
    .replace(/<!--\s*\.?\/?(?:#)?(?:entry-content|entry-header|entry-title|site-\w+|primary|main|colophon|masthead|page)[\w\s.#-]*-->/gi, "");
  return next;
}

export function rewriteAssetText(source: string, assetUrl: string) {
  const pageUrl = new URL(assetUrl, SITE_ORIGIN);
  let next = rewriteAbsoluteAssetUrls(source);
  if (assetUrl.endsWith(".css") || assetUrl.endsWith(".svg")) {
    next = next.replace(
      /(^|[^A-Za-z])url\(\s*(["']?)([^"')]+)\2\s*\)/gi,
      (match, prefix: string, quote: string, value: string) => {
        if (/^(data:|#)/i.test(value.trim())) return match;
        const rewritten = rewriteUrl(value, pageUrl);
        return rewritten === value.trim() ? match : `${prefix}url(${quote}${rewritten}${quote})`;
      },
    );
  }
  if (assetUrl.endsWith(".css") || assetUrl.includes("/assets/") || assetUrl.includes("/media/")) {
    next = scrubCss(next);
  }
  return next;
}

export function canonicalPathForFile(file: string) {
  const rel = "/" + path.relative(SITE_ROOT, file).split(path.sep).join("/");
  return rel;
}
