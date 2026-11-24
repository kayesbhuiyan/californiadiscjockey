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

function imageSize(file: string) {
  if (imageSizeCache.has(file)) return imageSizeCache.get(file) ?? null;
  let size: { w: number; h: number } | null = null;
  const fd = fs.openSync(file, "r");
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

function localStylesheets(raw: string, pageFile: string) {
  const dir = path.dirname(pageFile);
  const sheets: { href: string; file: string; defer: boolean }[] = [];
  for (const tag of raw.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = (readAttr(tag, "rel") || "").toLowerCase().split(/\s+/);
    if (!rel.includes("stylesheet")) continue;
    const href = readAttr(tag, "href");
    if (!href || /^(data:|https?:|\/\/)/i.test(href)) continue;
    const clean = href.split("?")[0].split("#")[0];
    const file = clean.startsWith("/")
      ? lookupFile(clean)
      : path.resolve(dir, clean);
    if (!file || !isInsideRoot(file) || !fs.existsSync(file)) continue;
    const publicHref = canonicalPathForFile(file);
    const media = (readAttr(tag, "media") || "all").toLowerCase();
    const defer = media === "print" || /font|roboto|tw_optimize/i.test(publicHref);
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
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (full, _quote: string, value: string) => {
      const clean = value.trim().split("?")[0];
      if (!clean.startsWith("/") || !/\.(?:woff2?|ttf|otf|eot)$/i.test(clean)) return full;
      return lookupFile(clean) ? full : "none";
    })
    .replace(/src:\s*none(?:\s+format\([^)]*\))?\s*,?/gi, "")
    .replace(/@font-face\s*\{[^{}]*\}/gi, (block) => (/src\s*:/i.test(block) ? block : ""));
  cssBundleCache.set(key, css);
  return css;
}

function optimizedImage(src: string, widthAttr: string | undefined) {
  const pathOnly = src.split("?")[0].split("#")[0];
  if (!pathOnly.startsWith("/wp-content/")) return null;
  if (/\.(svg|gif|ico)$/i.test(pathOnly)) return null;
  const file = lookupFile(pathOnly);
  if (!file) return null;
  const stated = Number(widthAttr);
  const widths = IMAGE_WIDTHS.filter((width) => !stated || stated >= 400 || width <= stated * 2 + 40);
  const chosen = widths.length ? widths : [640];
  const urlFor = (width: number) => `/_next/image?url=${encodeURIComponent(pathOnly)}&w=${width}&q=75`;
  return {
    file,
    src: urlFor(chosen[Math.min(chosen.length - 1, 2)] ?? chosen[0]),
    srcset: chosen.map((width) => `${urlFor(width)} ${width}w`).join(", "),
  };
}

function videoPoster(src: string) {
  const youtube = src.match(/(?:youtube\.com\/(?:embed\/|shorts\/|watch\?v=)|youtube-nocookie\.com\/embed\/|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  if (youtube) return `https://i.ytimg.com/vi/${youtube[1]}/hqdefault.jpg`;
  const instagram = src.match(/instagram\.com\/(?:reel|p|tv)\/([A-Za-z0-9_-]+)/);
  if (instagram) return `https://www.instagram.com/p/${instagram[1]}/media/?size=m`;
  const vimeo = src.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (vimeo) return `https://vumbnail.com/${vimeo[1]}.jpg`;
  return "";
}

function dropScript(tag: string, body: string) {
  const id = readAttr(tag, "id") || "";
  const type = (readAttr(tag, "type") || "").toLowerCase();
  const src = `${readAttr(tag, "src") || ""} ${readAttr(tag, "data-two_delay_src") || ""}`;
  if (type.includes("ld+json")) return false;
  if (/simple-image-slider/i.test(`${id} ${src}`)) return false;
  if (type === "speculationrules" || id === "two_worker") return true;
  if (/data-two-no-delay|data-two_delay/.test(tag)) return true;
  if (/wp-emoji|wpemoji|emoji-settings/i.test(`${id}\n${src}\n${body}`)) return true;
  if (/^(jquery-core|jquery-migrate|dropdown-ie|svgxuse|jquery-flexslider|tortuga-slider|hoverIntent|wp-hooks|wp-i18n|swv|contact-form-7|flying-pages|tortuga-navigation|elementor-|eael-|jquery-ui)/i.test(id)) {
    return true;
  }
  if (/jquery|elementor|contact-form-7|flying-pages|wp-embed|hoverintent|essential-addons|\/eael/i.test(src)) return true;
  return false;
}

function optimizeHtml(html: string, canonicalPath: string) {
  let next = html.replace(/<style\b[^>]*id=(["'])global-styles-inline-css\1[^>]*>[\s\S]*?<\/style>/gi, "");
  next = next.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (full, attrs: string, body: string) => {
    return dropScript(`<script ${attrs}>`, body) ? "" : full;
  });

  next = next.replace(/<link\b[^>]*>/gi, (tag) => {
    const rel = (readAttr(tag, "rel") || "").toLowerCase();
    const href = readAttr(tag, "href") || "";
    if (rel.split(/\s+/).includes("stylesheet") && href.startsWith("/wp-content/")) return "";
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
      (head) => `${head}<link rel="stylesheet" href="/_css?p=${encodeURIComponent(canonicalPath)}&k=block">`,
    );
  }
  const bundleLinks = [
    deferCss
      ? `<link rel="stylesheet" href="/_css?p=${encodeURIComponent(canonicalPath)}&k=defer" media="print" onload="this.media='all'"><noscript><link rel="stylesheet" href="/_css?p=${encodeURIComponent(canonicalPath)}&k=defer"></noscript>`
      : "",
    `<style id="cdj-speed">.elementor-invisible{visibility:visible!important}.cdj-lite{display:block;position:relative;width:100%;margin:0;padding:0;border:0;background:#111;color:#fff;cursor:pointer;overflow:hidden}.cdj-lite img{position:absolute;left:0;top:50%;width:100%;height:auto;transform:translateY(-50%)}.cdj-lite span{position:absolute;left:50%;top:50%;width:68px;height:48px;transform:translate(-50%,-50%);background:#f00;border-radius:14px;z-index:1}.cdj-lite span:before{content:"";position:absolute;left:27px;top:14px;border-style:solid;border-width:10px 0 10px 18px;border-color:transparent transparent transparent #fff}.entry-content a,.comment-reply-title span,#reply-title span,.must-log-in a{color:#2278b0 !important}.must-log-in a{text-decoration:underline !important}span[style*="ff6600" i]{color:#e85d00 !important}.sis-slider-wrapper .sis-dots{gap:12px !important}.sis-slider-wrapper .sis-dots .sis-dot{width:24px !important;height:24px !important;min-width:24px !important;min-height:24px !important;transform:none !important}html.cdj-nav{cursor:progress}.dj-container .dj-button{background:#e8c96a !important;color:#1a1a1a !important}.dj-container .dj-button:hover{background:#d4af37 !important;color:#1a1a1a !important}</style>`,
  ].join("");
  next = next.replace(/<\/head>/i, `${bundleLinks}</head>`);

  let lcp = "";
  let imageIndex = 0;
  next = next.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = readAttr(tag, "src") || "";
    if (!src || src.startsWith("data:") || src === "#") return tag;
    const optimized = optimizedImage(src, readAttr(tag, "width"));
    let updated = tag;
    if (optimized) {
      updated = setAttr(removeAttr(removeAttr(updated, "srcset"), "src"), "src", optimized.src);
      updated = setAttr(updated, "srcset", optimized.srcset);
      if (!readAttr(updated, "sizes")) updated = setAttr(updated, "sizes", "(max-width: 840px) 100vw, 840px");
      if (!readAttr(updated, "width")) {
        const size = imageSize(optimized.file);
        if (size) {
          updated = setAttr(updated, "width", String(size.w));
          updated = setAttr(updated, "height", String(size.h));
        }
      }
    }
    if (!readAttr(updated, "alt")) updated = setAttr(updated, "alt", "");
    const currentSrc = readAttr(updated, "src") || "";
    if (!currentSrc) {
      const fromSet = (readAttr(updated, "srcset") || "").split(",")[0]?.trim().split(/\s+/)[0];
      if (fromSet) updated = setAttr(updated, "src", fromSet);
    }
    imageIndex += 1;
    updated = setAttr(updated, "decoding", "async");
    const priority = (readAttr(updated, "fetchpriority") || "").toLowerCase();
    if (imageIndex === 1 || priority === "high") {
      updated = removeAttr(removeAttr(updated, "loading"), "fetchpriority");
      updated = setAttr(setAttr(updated, "loading", "eager"), "fetchpriority", "high");
      const preloadSrc = readAttr(updated, "src") || src;
      const preloadSet = readAttr(updated, "srcset");
      const preloadSizes = readAttr(updated, "sizes");
      lcp = `<link rel="preload" as="image" href="${preloadSrc}"${preloadSet ? ` imagesrcset="${preloadSet}"` : ""}${preloadSizes ? ` imagesizes="${preloadSizes}"` : ""} fetchpriority="high">`;
    } else if (!readAttr(updated, "loading")) {
      updated = setAttr(updated, "loading", "lazy");
    }
    return updated;
  });
  if (lcp) next = next.replace(/<\/head>/i, `${lcp}</head>`);

  next = next.replace(/<thead\b[^>]*>[\s\S]*?<\/thead>/gi, (thead) =>
    thead.replace(/<td\b/gi, "<th").replace(/<\/td>/gi, "</th>"),
  );
  next = next.replace(/<a\b([^>]*)>(\s*)More(\s*)<\/a>/gi, (full, attrs: string, before: string, after: string) => {
    const title = readAttr(`<a ${attrs}>`, "title");
    const label = title && !/^more$/i.test(title.trim()) ? title : "More details";
    return `<a ${attrs}>${before}${label}${after}</a>`;
  });

  next = next.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, (tag) => {
    const src = readAttr(tag, "src") || readAttr(tag, "data-src") || "";
    if (!/youtube\.com|youtu\.be|youtube-nocookie\.com|instagram\.com|vimeo\.com/i.test(src)) {
      return /loading=/i.test(tag) ? tag : setAttr(tag, "loading", "lazy");
    }
    const title = (readAttr(tag, "title") || "video").replace(/"/g, "&quot;");
    const playable = src.includes("autoplay=") ? src : `${src}${src.includes("?") ? "&" : "?"}autoplay=1`;
    const ratio = /instagram\.com\/reel|instagram\.com\/p/i.test(src) ? "9/16" : "16/9";
    const poster = videoPoster(src);
    const image = poster
      ? `<img src="${poster}" alt="" width="${ratio === "9/16" ? "360" : "480"}" height="${ratio === "9/16" ? "640" : "360"}" loading="lazy" decoding="async" fetchpriority="low">`
      : "";
    return `<button type="button" class="cdj-lite" style="aspect-ratio:${ratio}" data-src="${playable.replace(/"/g, "&quot;")}" data-title="${title}" data-ratio="${ratio}" aria-label="Play ${title}">${image}<span></span></button>`;
  });

  if (!next.includes('id="cdj-runtime"')) {
    next = next.replace(
      /<\/body>/i,
      `<script id="cdj-runtime" type="module">
const NAV_LINK="nav.main-navigation a, nav.top-navigation a";
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
    if(old.src&&old.src.indexOf("simple-image-slider")!==-1)delete window.__sisLoaded;
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
document.addEventListener("click",(event)=>{
  const target=event.target;
  if(!(target instanceof Element))return;
  const toggle=target.closest(".menu-toggle");
  if(toggle){
    const wrap=toggle.closest(".primary-navigation-wrap,.header-bar");
    const nav=wrap&&wrap.querySelector(".main-navigation,.top-navigation");
    if(nav){
      const open=nav.classList.toggle("toggled-on");
      toggle.setAttribute("aria-expanded",open?"true":"false");
    }
    return;
  }
  const parentLink=target.closest(".menu-item-has-children > a, .page_item_has_children > a");
  if(parentLink&&window.matchMedia("(max-width: 60em)").matches){
    const sub=parentLink.parentElement&&parentLink.parentElement.querySelector(":scope > .sub-menu");
    if(sub&&!sub.classList.contains("toggled-on")){event.preventDefault();sub.classList.add("toggled-on");return;}
  }
  const lite=target.closest(".cdj-lite");
  if(lite){
    const frame=document.createElement("iframe");
    frame.src=lite.dataset.src||"";
    frame.title=lite.dataset.title||"Video";
    frame.allow="autoplay; encrypted-media; picture-in-picture";
    frame.allowFullscreen=true;
    frame.style.width="100%";
    frame.style.border="0";
    frame.style.aspectRatio=lite.dataset.ratio||"16/9";
    lite.replaceWith(frame);
    return;
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

  next = next.replace(/<script\b[^>]*id=(["'])simple-image-slider-js\1[^>]*>/gi, (tag) => {
    let src = readAttr(tag, "src") || readAttr(tag, "data-two_delay_src") || "";
    if (!src || src === "inline") return "";
    src = src.replace(/^https?:\/\/(?:www\.)?californiadiscjockey\.com/i, "");
    let updated = setAttr(tag, "src", src);
    if (!/\sdefer(?:\s|=|>)/i.test(updated)) updated = updated.replace(/>$/, " defer>");
    return updated;
  });
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
  if (options?.blockIndexing) next = forceNoindex(next, "noindex, nofollow");
  else if (noindex) next = forceNoindex(next);
  next = optimizeHtml(next, canonicalPath);
  return restoreSeoBlocks(next, protectedSeo.blocks);
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
  return next;
}

export function canonicalPathForFile(file: string) {
  const rel = "/" + path.relative(SITE_ROOT, file).split(path.sep).join("/");
  return rel;
}
