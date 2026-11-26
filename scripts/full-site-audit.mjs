/**
 * Full-site WP vs Next audit: pages, media, videos, meta.
 * Usage: node scripts/full-site-audit.mjs
 */
import fs from "fs";
import path from "path";
import http from "http";
import https from "https";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT = path.join(process.env.TEMP || "/tmp", "cdj-full-audit");
const WP = "http://127.0.0.1:80/californiadiscjockey";
const NX = "http://127.0.0.1:3000";
const PUBLIC = path.join(ROOT, "public");
const CONCURRENCY = 8;

fs.mkdirSync(OUT, { recursive: true });

function fetchText(url, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).href;
        res.resume();
        return resolve(fetchText(next, timeoutMs));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({ status, body, finalUrl: url });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout " + url));
    });
  });
}

function fetchBuffer(url, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).href;
        res.resume();
        return resolve(fetchBuffer(next, timeoutMs));
      }
      if (status !== 200) {
        res.resume();
        return reject(new Error("HTTP " + status));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function meta(html, key) {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let m = html.match(new RegExp(`(?:property|name)=["']${esc}["'][^>]*content=["']([^"']*)["']`, "i"));
  if (m) return m[1];
  m = html.match(new RegExp(`content=["']([^"']*)["'][^>]*(?:property|name)=["']${esc}["']`, "i"));
  return m ? m[1] : "";
}

function titleOf(html) {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? m[1].trim() : "";
}

function normPath(u) {
  let p = u
    .replace(/^https?:\/\/[^/]+\/californiadiscjockey/i, "")
    .replace(/^https?:\/\/(?:www\.)?californiadiscjockey\.com/i, "");
  if (/^https?:\/\//i.test(p)) return null;
  if (!p.startsWith("/")) p = "/" + p;
  p = p.split("?")[0].split("#")[0];
  if (!/\.[a-z0-9]+$/i.test(p) && !p.endsWith("/")) p += "/";
  return p;
}

function extractMedia(html) {
  const set = new Set();
  const re = /\/wp-content\/uploads\/([^"'\\\s>]+\.(?:jpg|jpeg|png|gif|webp|avif|mp4|webm))/gi;
  let m;
  while ((m = re.exec(html))) set.add(m[1].replace(/\\/g, "/"));
  const re2 = /\/media\/([^"'\\\s>]+\.(?:jpg|jpeg|png|gif|webp|avif|mp4|webm))/gi;
  while ((m = re2.exec(html))) set.add(m[1].replace(/\\/g, "/"));
  // next/image
  const re3 = /\/_next\/image\?url=([^&"']+)/gi;
  while ((m = re3.exec(html))) {
    try {
      const decoded = decodeURIComponent(m[1]);
      const mm = decoded.match(/\/media\/(.+\.(?:jpg|jpeg|png|gif|webp|avif))/i);
      if (mm) set.add(mm[1]);
    } catch {}
  }
  return [...set];
}

function extractVideoIds(html) {
  const ids = new Set();
  const re =
    /(?:youtube(?:-nocookie)?\.com\/(?:embed\/(?!videoseries)|shorts\/|watch\?v=)|youtu\.be\/)([A-Za-z0-9_-]{11})|instagram\.com\/(?:reel|p|tv)\/([A-Za-z0-9_-]+)|vimeo\.com\/(?:video\/)?(\d+)/gi;
  let m;
  while ((m = re.exec(html))) {
    ids.add(m[1] || m[2] || m[3]);
  }
  // local ig mp4
  const re2 = /\/media\/instagram\/([A-Za-z0-9_-]+)\.mp4/gi;
  while ((m = re2.exec(html))) ids.add(m[1]);
  return [...ids];
}

function basenameNoSize(rel) {
  const base = path.posix.basename(rel);
  return base.replace(/-\d+x\d+(?=\.[a-z0-9]+$)/i, "").toLowerCase();
}

function localExists(rel) {
  const full = path.join(PUBLIC, "media", rel);
  if (fs.existsSync(full)) return true;
  const unsized = rel.replace(/-\d+x\d+(?=\.[a-z0-9]+$)/i, "");
  if (unsized !== rel && fs.existsSync(path.join(PUBLIC, "media", unsized))) return true;
  // jpeg/jpg swap
  if (/\.jpeg$/i.test(rel)) {
    const jpg = rel.replace(/\.jpeg$/i, ".jpg");
    if (fs.existsSync(path.join(PUBLIC, "media", jpg))) return true;
  }
  if (/\.jpg$/i.test(rel)) {
    const jpeg = rel.replace(/\.jpg$/i, ".jpeg");
    if (fs.existsSync(path.join(PUBLIC, "media", jpeg))) return true;
  }
  return false;
}

function isAttachmentPage(html, pagePath) {
  if (/class="[^"]*\battachment\b/i.test(html)) return true;
  if (/<body[^>]*\battachment\b/i.test(html)) return true;
  if (/property=["']og:type["'][^>]*content=["']article["']/i.test(html) &&
      /wp-image-|attachment-|attachmentid/i.test(html) &&
      /class="[^"]*wp-block-image|attachment-full|entry-attachment/i.test(html)) {
    return true;
  }
  const slug = pagePath.replace(/\/+$/, "").split("/").pop() || "";
  if (/-\d+x\d+$/i.test(slug)) return true;
  if (/^(img_|image-?\d|pic\d|screenshot|maxresdefault|signature|requested-card|song-card)/i.test(slug))
    return true;
  return false;
}

async function loadWpPages() {
  const pages = new Set();
  const index = await fetchText(WP + "/sitemap_index.xml");
  const locs = [...index.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  for (const loc of locs) {
    if (!/\.xml$/i.test(loc)) continue;
    const subPath = normPath(loc);
    if (!subPath) continue;
    try {
      const sub = await fetchText(WP + subPath);
      for (const m of sub.body.matchAll(/<loc>([^<]+)<\/loc>/g)) {
        const p = normPath(m[1]);
        if (p && !/\.xml$/i.test(p)) pages.add(p);
      }
    } catch (e) {
      console.warn("sitemap sub fail", loc, e.message);
    }
  }
  return [...pages].sort();
}

function loadNextPages() {
  const site = path.join(ROOT, "html-site");
  const pages = [];
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (/^(feed|embed|wp-admin|wp-json|wp-content|wp-includes|comments)$/i.test(ent.name)) continue;
        walk(full);
        continue;
      }
      if (ent.name !== "index.html") continue;
      let rel = path.relative(site, dir).split(path.sep).join("/");
      let p = rel ? `/${rel}/` : "/";
      if (/(test|test-2|testimonil-page|bar-demon|bay-area-dj-old)/i.test(p)) continue;
      if (/chrome-extension_|\/\$/.test(p)) continue;
      pages.push(p);
    }
  }
  walk(site);
  return pages.sort();
}

async function main() {
  console.log("Loading page lists...");
  const wpPages = await loadWpPages();
  const nextPages = loadNextPages();
  const nextSet = new Set(nextPages.map((p) => p.toLowerCase()));
  const wpSet = new Set(wpPages.map((p) => p.toLowerCase()));

  console.log(`WP sitemap pages: ${wpPages.length}`);
  console.log(`Next content pages: ${nextPages.length}`);

  const wpOnly = wpPages.filter((p) => !nextSet.has(p.toLowerCase()));
  const nextOnly = nextPages.filter((p) => !wpSet.has(p.toLowerCase()));

  // Classify WP-only
  console.log(`Classifying ${wpOnly.length} WP-only pages...`);
  const wpOnlyReal = [];
  const wpOnlyAttach = [];
  const wpOnlyErr = [];
  await mapPool(wpOnly, CONCURRENCY, async (p) => {
    try {
      const res = await fetchText(WP + p);
      if (res.status === 404) {
        wpOnlyErr.push({ page: p, err: "404" });
        return;
      }
      if (isAttachmentPage(res.body, p)) wpOnlyAttach.push(p);
      else {
        const t = titleOf(res.body);
        const canon = meta(res.body, "og:url") || "";
        wpOnlyReal.push({ page: p, title: t, canon });
      }
    } catch (e) {
      wpOnlyErr.push({ page: p, err: e.message });
    }
  });

  fs.writeFileSync(path.join(OUT, "wp-only-real.json"), JSON.stringify(wpOnlyReal, null, 2));
  fs.writeFileSync(path.join(OUT, "wp-only-attach.txt"), wpOnlyAttach.join("\n"));
  console.log(`WP-only real=${wpOnlyReal.length} attach=${wpOnlyAttach.length} err=${wpOnlyErr.length}`);

  // Shared pages audit
  const shared = wpPages.filter((p) => nextSet.has(p.toLowerCase()));
  // Always include all next pages that exist on WP; also crawl next pages even if not in WP sitemap
  const crawlPages = [...new Set([...shared, ...nextPages.filter((p) => wpSet.has(p.toLowerCase()))])].sort();
  console.log(`Auditing ${crawlPages.length} shared pages...`);

  const pageReports = [];
  const missingMedia = new Set();
  const allWpMedia = new Set();

  await mapPool(crawlPages, CONCURRENCY, async (p, idx) => {
    if (idx % 50 === 0) console.log(`  progress ${idx}/${crawlPages.length}`);
    let wpHtml = "";
    let nxHtml = "";
    let wpStatus = 0;
    let nxStatus = 0;
    try {
      const w = await fetchText(WP + p);
      wpStatus = w.status;
      wpHtml = w.body;
    } catch {
      wpStatus = 0;
    }
    try {
      const n = await fetchText(NX + p);
      nxStatus = n.status;
      nxHtml = n.body;
    } catch {
      nxStatus = 0;
    }

    const report = {
      page: p,
      wpStatus,
      nxStatus,
      titleMatch: true,
      descMatch: true,
      missingVideos: [],
      missingImageBasenames: [],
      relativeOg: false,
      wpTitle: "",
      nxTitle: "",
    };

    if (wpStatus === 200 && nxStatus === 200) {
      report.wpTitle = titleOf(wpHtml);
      report.nxTitle = titleOf(nxHtml);
      report.titleMatch = report.wpTitle.replace(/\s+/g, " ") === report.nxTitle.replace(/\s+/g, " ");
      const wd = meta(wpHtml, "description");
      const nd = meta(nxHtml, "description");
      report.descMatch = !wd || wd === nd;
      const og = meta(nxHtml, "og:image");
      report.relativeOg = /^\.\.\//.test(og) || (!!og && !/^https?:\/\//i.test(og) && !og.startsWith("/"));
      if (og && og.startsWith("/") && !og.startsWith("//")) {
        // still relative-to-host; our absolutize should make absolute — flag if not absolute
        report.relativeOg = true;
      }
      // Prefer: absolute https
      report.relativeOg = !!og && !/^https?:\/\//i.test(og);

      const wpVids = extractVideoIds(wpHtml);
      report.missingVideos = wpVids.filter((id) => !nxHtml.includes(id));

      const wpMedia = extractMedia(wpHtml);
      for (const rel of wpMedia) {
        allWpMedia.add(rel);
        if (!localExists(rel)) missingMedia.add(rel);
      }
      const nxBases = new Set(extractMedia(nxHtml).map(basenameNoSize));
      // Only flag content images missing from Next HTML (not every sidebar chrome)
      // Compare by basename presence for uploads that appear in main content roughly:
      const missingBases = [];
      for (const rel of wpMedia) {
        const b = basenameNoSize(rel);
        if (!nxBases.has(b) && !nxHtml.toLowerCase().includes(b.replace(/\.[a-z0-9]+$/, ""))) {
          // skip if only in comments on WP
          const fname = path.posix.basename(rel);
          const idxInWp = wpHtml.indexOf(fname);
          if (idxInWp >= 0) {
            const before = wpHtml.slice(Math.max(0, idxInWp - 80), idxInWp);
            if (before.includes("<!--")) continue;
          }
          missingBases.push(rel);
        }
      }
      report.missingImageBasenames = missingBases.slice(0, 20);
    } else {
      report.titleMatch = false;
      report.descMatch = false;
    }
    pageReports.push(report);
  });

  // Also collect media from Next HTML files on disk for any local gaps
  console.log("Scanning html-site for media refs...");
  function walkHtml(dir, files = []) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walkHtml(full, files);
      else if (ent.name.endsWith(".html")) files.push(full);
    }
    return files;
  }
  for (const file of walkHtml(path.join(ROOT, "html-site"))) {
    const html = fs.readFileSync(file, "utf8");
    for (const rel of extractMedia(html)) {
      allWpMedia.add(rel);
      if (!localExists(rel)) missingMedia.add(rel);
    }
  }

  // Download missing media
  const toDownload = [...missingMedia].sort();
  console.log(`Missing media files to download: ${toDownload.length}`);
  const downloaded = [];
  const failed = [];
  await mapPool(toDownload, 4, async (rel) => {
    const dest = path.join(PUBLIC, "media", rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      const buf = await fetchBuffer(`${WP}/wp-content/uploads/${rel}`);
      fs.writeFileSync(dest, buf);
      downloaded.push(rel);
      console.log("DL", rel, buf.length);
    } catch {
      const unsized = rel.replace(/-\d+x\d+(?=\.[a-z0-9]+$)/i, "");
      if (unsized !== rel) {
        try {
          const dest2 = path.join(PUBLIC, "media", unsized);
          fs.mkdirSync(path.dirname(dest2), { recursive: true });
          const buf = await fetchBuffer(`${WP}/wp-content/uploads/${unsized}`);
          fs.writeFileSync(dest2, buf);
          downloaded.push(unsized);
          console.log("DL ALT", unsized, buf.length);
          return;
        } catch {}
      }
      failed.push(rel);
      console.log("FAIL", rel);
    }
  });

  const titleDiffs = pageReports.filter((r) => r.wpStatus === 200 && r.nxStatus === 200 && !r.titleMatch);
  const descDiffs = pageReports.filter((r) => r.wpStatus === 200 && r.nxStatus === 200 && !r.descMatch);
  const videoGaps = pageReports.filter((r) => r.missingVideos?.length);
  const imageGaps = pageReports.filter((r) => r.missingImageBasenames?.length);
  const relativeOg = pageReports.filter((r) => r.relativeOg);
  const nxFail = pageReports.filter((r) => r.wpStatus === 200 && r.nxStatus !== 200);

  const summary = {
    wpPages: wpPages.length,
    nextPages: nextPages.length,
    sharedAudited: crawlPages.length,
    wpOnlyTotal: wpOnly.length,
    wpOnlyReal: wpOnlyReal.length,
    wpOnlyAttach: wpOnlyAttach.length,
    wpOnlyErr: wpOnlyErr.length,
    nextOnlyNotInWpSitemap: nextOnly.length,
    titleDiffs: titleDiffs.length,
    descDiffs: descDiffs.length,
    pagesWithVideoGaps: videoGaps.length,
    pagesWithImageGaps: imageGaps.length,
    relativeOgPages: relativeOg.length,
    next404WhereWpOk: nxFail.length,
    mediaDownloaded: downloaded.length,
    mediaFailed: failed.length,
  };

  const report = {
    summary,
    wpOnlyReal,
    titleDiffs: titleDiffs.slice(0, 50),
    descDiffs: descDiffs.slice(0, 50),
    videoGaps: videoGaps.map((r) => ({ page: r.page, missing: r.missingVideos })),
    imageGaps: imageGaps.map((r) => ({ page: r.page, missing: r.missingImageBasenames.slice(0, 10) })),
    relativeOg: relativeOg.map((r) => r.page).slice(0, 30),
    nxFail: nxFail.map((r) => ({ page: r.page, nxStatus: r.nxStatus })),
    downloaded,
    failed,
    nextOnlySample: nextOnly.slice(0, 40),
  };

  fs.writeFileSync(path.join(OUT, "full-report.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log("Report:", path.join(OUT, "full-report.json"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
