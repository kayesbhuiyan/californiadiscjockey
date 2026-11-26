/**
 * Audit local WP vs local Next content parity for all crawlable pages.
 * Report only — does not modify files.
 *
 * WP:  http://localhost/californiadiscjockey/...
 * Next: http://127.0.0.1:3000/...
 */
import fs from "fs";

const WP_BASE = "http://localhost/californiadiscjockey";
const NX_BASE = "http://127.0.0.1:3000";
const OUT = "scripts/wp-next-parity-report.json";
const OUT_MD = "scripts/wp-next-parity-report.md";

async function fetchText(url, timeoutMs = 45000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, finalUrl: res.url };
  } catch (e) {
    return { ok: false, status: 0, text: "", error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

async function listWpPaths() {
  const paths = new Set();

  // Prefer Yoast / WP sitemap
  for (const sm of [
    `${WP_BASE}/wp-sitemap-pages-1.xml`,
    `${WP_BASE}/page-sitemap.xml`,
    `${WP_BASE}/post-sitemap.xml`,
    `${WP_BASE}/wp-sitemap-posts-page-1.xml`,
    `${WP_BASE}/wp-sitemap-posts-post-1.xml`,
  ]) {
    const r = await fetchText(sm, 60000);
    if (!r.ok) continue;
    for (const m of r.text.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)) {
      try {
        const u = new URL(m[1].trim());
        let p = u.pathname.replace(/^\/californiadiscjockey/i, "");
        if (!p.endsWith("/")) p += "/";
        if (p === "//") p = "/";
        paths.add(p === "" ? "/" : p);
      } catch {}
    }
  }

  // REST pages + posts as backup
  for (const type of ["pages", "posts"]) {
    for (let page = 1; page <= 50; page++) {
      const url = `${WP_BASE}/wp-json/wp/v2/${type}?per_page=100&page=${page}&_fields=link,slug,status`;
      const r = await fetchText(url, 60000);
      if (!r.ok) break;
      let rows = [];
      try {
        rows = JSON.parse(r.text);
      } catch {
        break;
      }
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const row of rows) {
        try {
          const u = new URL(row.link);
          let p = u.pathname.replace(/^\/californiadiscjockey/i, "");
          if (!p.endsWith("/")) p += "/";
          paths.add(p === "" ? "/" : p);
        } catch {}
      }
      if (rows.length < 100) break;
    }
  }

  // Always include home
  paths.add("/");
  return [...paths].sort();
}

function extractBody(html) {
  const m =
    html.match(
      /<(?:div|article)[^>]*\b(?:entry-content|post-body|type-page|type-post)\b[^>]*>([\s\S]*?)(?:<div[^>]*\bdj-footer-banner\b|<aside\b|id="secondary"|id="comments"|class="[^"]*comments-area)/i,
    ) ||
    html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i) ||
    html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  return m?.[1] || "";
}

function normalizeText(html) {
  return html
    .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|section|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&#8216;|&lsquo;/g, "'")
    .replace(/&#8220;|&ldquo;/g, '"')
    .replace(/&#8221;|&rdquo;/g, '"')
    .replace(/&#8211;|&ndash;/g, "–")
    .replace(/&#8212;|&mdash;/g, "—")
    .replace(/&#038;|&amp;/g, "&")
    .replace(/https?:\/\/localhost\/californiadiscjockey/gi, "")
    .replace(/https?:\/\/(?:www\.)?californiadiscjockey\.com/gi, "")
    .replace(/\/wp-content\/uploads\//gi, "/media/")
    .replace(/\s+/g, " ")
    .trim();
}

function imageFiles(html) {
  const files = new Set();
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const src = m[0].match(/\bsrc=["']([^"']+)/i)?.[1] || "";
    const clean = decodeURIComponent(src)
      .replace(/^https?:\/\/[^/]+/i, "")
      .replace(/^.*?url=/, "")
      .replace(/&.*$/, "")
      .replace(/\/_next\/image\?url=%2F/i, "/")
      .replace(/%2F/gi, "/")
      .replace(/\/wp-content\/uploads\//gi, "/media/")
      .replace(/\?.*$/, "");
    const base = clean.split("/").pop() || "";
    if (base && !/^(emoji|smiley|blank|spacer|pixel)/i.test(base)) files.add(base.toLowerCase());
  }
  return [...files].sort();
}

function videoIds(html) {
  const ids = new Set();
  for (const m of html.matchAll(
    /(?:youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?v=)|youtu\.be\/|vi\/)([A-Za-z0-9_-]{11})/gi,
  )) {
    ids.add(m[1]);
  }
  for (const m of html.matchAll(/[?&]list=([A-Za-z0-9_-]+)/gi)) ids.add(`list:${m[1]}`);
  for (const m of html.matchAll(/instagram\.com\/(?:reel|p|tv)\/([A-Za-z0-9_-]+)/gi)) ids.add(`ig:${m[1]}`);
  for (const m of html.matchAll(/vimeo\.com\/(?:video\/)?(\d+)/gi)) ids.add(`vimeo:${m[1]}`);
  return [...ids].sort();
}

function missingChunks(src, dst, size = 48) {
  const out = [];
  for (let i = 0; i + size < src.length; i += size) {
    const chunk = src.slice(i, i + size);
    if (chunk.trim().length < 20) continue;
    if (!dst.includes(chunk)) out.push(chunk);
  }
  return out;
}

function diffArrays(a, b) {
  const as = new Set(a);
  const bs = new Set(b);
  return {
    onlyA: a.filter((x) => !bs.has(x)),
    onlyB: b.filter((x) => !as.has(x)),
  };
}

const paths = await listWpPaths();
console.log(`Found ${paths.length} WP paths`);

const results = [];
let same = 0;
let differ = 0;
let missingOnNext = 0;
let wpErrors = 0;

// Concurrency limited
const CONCURRENCY = 4;
let idx = 0;

async function worker() {
  while (idx < paths.length) {
    const i = idx++;
    const path = paths[i];
    process.stdout.write(`\r[${i + 1}/${paths.length}] ${path.slice(0, 60).padEnd(60)}`);

    const wpUrl = path === "/" ? `${WP_BASE}/` : `${WP_BASE}${path}`;
    const nxUrl = path === "/" ? `${NX_BASE}/` : `${NX_BASE}${path}`;

    const [wp, nx] = await Promise.all([fetchText(wpUrl), fetchText(nxUrl)]);

    if (!wp.ok) {
      wpErrors++;
      results.push({ path, status: "wp_error", wpStatus: wp.status, error: wp.error || null });
      continue;
    }
    if (!nx.ok) {
      missingOnNext++;
      results.push({
        path,
        status: "missing_on_next",
        wpStatus: wp.status,
        nxStatus: nx.status,
      });
      continue;
    }

    const wpBody = extractBody(wp.text);
    const nxBody = extractBody(nx.text);
    const wpText = normalizeText(wpBody);
    const nxText = normalizeText(nxBody);
    const wpImgs = imageFiles(wpBody || wp.text);
    const nxImgs = imageFiles(nxBody || nx.text);
    const wpVids = videoIds(wpBody || wp.text);
    const nxVids = videoIds(nxBody || nx.text);

    const textOnlyWp = missingChunks(wpText, nxText);
    const textOnlyNx = missingChunks(nxText, wpText);
    const imgDiff = diffArrays(wpImgs, nxImgs);
    const vidDiff = diffArrays(wpVids, nxVids);

    // Ignore pure path/optimizer filename noise: compare stems without size suffixes when possible
    const stem = (f) => f.replace(/-\d+x\d+(?=\.)/, "").replace(/\.(webp|jpg|jpeg|png|gif|avif)$/i, "");
    const wpStems = new Set(wpImgs.map(stem));
    const nxStems = new Set(nxImgs.map(stem));
    const imgsMissingOnNext = [...wpStems].filter((s) => ![...nxStems].some((n) => n.includes(s) || s.includes(n)));
    const imgsExtraOnNext = [...nxStems].filter(
      (s) => !/mqdefault|hqdefault|ytimg/i.test(s) && ![...wpStems].some((w) => w.includes(s) || s.includes(w)),
    );

    const issues = [];
    if (textOnlyWp.length > 2) issues.push("text_missing_on_next");
    if (textOnlyNx.length > 2) issues.push("text_extra_on_next");
    if (imgsMissingOnNext.length) issues.push("images_missing_on_next");
    if (vidDiff.onlyA.length) issues.push("videos_missing_on_next");
    if (vidDiff.onlyB.length) issues.push("videos_extra_on_next");

    const textScore =
      wpText.length === 0 && nxText.length === 0
        ? 1
        : 1 - Math.min(1, (textOnlyWp.length + textOnlyNx.length) / Math.max(1, Math.ceil(wpText.length / 48)));

    if (issues.length === 0 || (textScore > 0.97 && !imgsMissingOnNext.length && !vidDiff.onlyA.length && !vidDiff.onlyB.length)) {
      same++;
      results.push({
        path,
        status: "same",
        textLen: { wp: wpText.length, nx: nxText.length },
        images: wpImgs.length,
        videos: wpVids.length,
      });
    } else {
      differ++;
      results.push({
        path,
        status: "differ",
        issues,
        textScore: Number(textScore.toFixed(3)),
        textLen: { wp: wpText.length, nx: nxText.length },
        wpOnlyTextSamples: textOnlyWp.slice(0, 5),
        nxOnlyTextSamples: textOnlyNx.slice(0, 5),
        imagesMissingOnNext: imgsMissingOnNext.slice(0, 20),
        imagesExtraOnNext: imgsExtraOnNext.slice(0, 20),
        videosMissingOnNext: vidDiff.onlyA,
        videosExtraOnNext: vidDiff.onlyB,
        wpImages: wpImgs.slice(0, 30),
        nxImages: nxImgs.slice(0, 30),
        wpVideos: wpVids,
        nxVideos: nxVids,
      });
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
console.log("\nDone.");

const summary = {
  generatedAt: new Date().toISOString(),
  wpBase: WP_BASE,
  nextBase: NX_BASE,
  totalPaths: paths.length,
  same,
  differ,
  missingOnNext,
  wpErrors,
};

const differing = results.filter((r) => r.status === "differ");
const missing = results.filter((r) => r.status === "missing_on_next");
const errors = results.filter((r) => r.status === "wp_error");

fs.writeFileSync(
  OUT,
  JSON.stringify({ summary, differing, missingOnNext: missing, wpErrors: errors, all: results }, null, 2),
);

const md = [];
md.push(`# WP ↔ Next content parity report (local)`);
md.push("");
md.push(`Generated: ${summary.generatedAt}`);
md.push("");
md.push(`- WP: \`${WP_BASE}\``);
md.push(`- Next: \`${NX_BASE}\``);
md.push(`- Pages checked: **${summary.totalPaths}**`);
md.push(`- Same content: **${summary.same}**`);
md.push(`- Different content: **${summary.differ}**`);
md.push(`- Missing on Next: **${summary.missingOnNext}**`);
md.push(`- WP fetch errors: **${summary.wpErrors}**`);
md.push("");

if (missing.length) {
  md.push(`## Missing on Next (${missing.length})`);
  for (const r of missing.slice(0, 100)) md.push(`- \`${r.path}\` (Next ${r.nxStatus})`);
  if (missing.length > 100) md.push(`- …and ${missing.length - 100} more`);
  md.push("");
}

if (differing.length) {
  md.push(`## Content differences (${differing.length})`);
  md.push("");
  for (const r of differing.slice(0, 80)) {
    md.push(`### \`${r.path}\``);
    md.push(`- Issues: ${r.issues.join(", ")}`);
    md.push(`- Text score: ${r.textScore} (WP ${r.textLen.wp} chars / Next ${r.textLen.nx} chars)`);
    if (r.videosMissingOnNext?.length) md.push(`- Videos missing on Next: \`${r.videosMissingOnNext.join("`, `")}\``);
    if (r.videosExtraOnNext?.length) md.push(`- Videos extra on Next: \`${r.videosExtraOnNext.join("`, `")}\``);
    if (r.imagesMissingOnNext?.length) md.push(`- Images missing on Next: \`${r.imagesMissingOnNext.join("`, `")}\``);
    if (r.wpOnlyTextSamples?.length) {
      md.push(`- WP text not found on Next:`);
      for (const s of r.wpOnlyTextSamples) md.push(`  - ${JSON.stringify(s)}`);
    }
    md.push("");
  }
  if (differing.length > 80) md.push(`_…and ${differing.length - 80} more differing pages in JSON report._`);
}

if (!differing.length && !missing.length) {
  md.push(`## Result`);
  md.push(`All checked pages match for text / images / videos.`);
}

fs.writeFileSync(OUT_MD, md.join("\n"));
console.log(JSON.stringify(summary, null, 2));
console.log(`Wrote ${OUT}`);
console.log(`Wrote ${OUT_MD}`);
